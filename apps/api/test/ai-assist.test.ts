import { afterAll, expect, test } from "bun:test";
import { MockLanguageModelV4 } from "ai/test";
import { createDatabase, type Database } from "@weft/db";
import { withRollback } from "../../../packages/db/src/test-helpers";
import { createApp } from "../src/app";
import { ASSIST_TASKS, MAX_ASSIST_CHARS } from "../src/ai";

const { client, db } = createDatabase();
afterAll(async () => client.end());

const usage = { inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 3, text: 3, reasoning: 0 } };
const textModel = (text = "Assisted text") => new MockLanguageModelV4({
  doGenerate: async () => ({
    content: [{ type: "text", text }], finishReason: { unified: "stop", raw: undefined }, usage, warnings: [],
  }),
});

async function setup(database: Database, options: { model?: MockLanguageModelV4; limit?: number; now?: () => number } = {}) {
  const model = options.model ?? textModel();
  const app = createApp(undefined, database, undefined, model, undefined, { aiAssistRequestsPerMinute: options.limit, aiAssistNow: options.now });
  const call = (path: string, body: unknown, cookie?: string) => app.handle(new Request(`http://localhost${path}`, {
    method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body),
  }));
  const signUp = async (name: string) => (await call("/api/auth/sign-up/email", { name, email: `${crypto.randomUUID()}@example.test`, password: "a-secure-password" })).headers.get("set-cookie")!.split(";")[0]!;
  const admin = await signUp("Admin");
  const workspace = await (await call("/actions/create_workspace", { name: "Team", slug: `t-${crypto.randomUUID()}` }, admin)).json() as { id: string };
  const join = async (role: "Member" | "Guest") => {
    const invite = await (await call("/actions/create_invite", { workspaceId: workspace.id, role }, admin)).json() as { token: string };
    const cookie = await signUp(role);
    await call("/actions/accept_invite", { token: invite.token }, cookie);
    return cookie;
  };
  return { model, call, signUp, admin, workspace, join };
}

test.concurrent("each task returns the model text as plain text", async () => {
  await withRollback(db, async (tx) => {
    const { call, workspace, join, model } = await setup(tx);
    const member = await join("Member");
    for (const task of ASSIST_TASKS) {
      const response = await call("/api/ai/assist", { workspaceId: workspace.id, task, text: "hello world", ...(task === "translate" ? { targetLanguage: "Thai" } : {}) }, member);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ text: "Assisted text" });
    }
    expect(model.doGenerateCalls).toHaveLength(ASSIST_TASKS.length);
    // the selected text reaches the model as the user turn, with no tools offered
    expect(JSON.stringify(model.doGenerateCalls[0]!.prompt)).toContain("hello world");
    expect(model.doGenerateCalls[0]!.tools ?? []).toEqual([]);
  });
});

test.concurrent("translate sends the target language to the model", async () => {
  await withRollback(db, async (tx) => {
    const { call, workspace, join, model } = await setup(tx);
    const member = await join("Member");
    await call("/api/ai/assist", { workspaceId: workspace.id, task: "translate", text: "hello", targetLanguage: "Japanese" }, member);
    expect(JSON.stringify(model.doGenerateCalls[0]!.prompt)).toContain("Japanese");
  });
});

test.concurrent("rejects over-long, empty, unknown-task, and translate-without-language input", async () => {
  await withRollback(db, async (tx) => {
    const { call, workspace, join, model } = await setup(tx);
    const member = await join("Member");
    const post = (body: Record<string, unknown>) => call("/api/ai/assist", { workspaceId: workspace.id, ...body }, member);
    expect((await post({ task: "rephrase", text: "x".repeat(MAX_ASSIST_CHARS) })).status).toBe(200);
    expect((await post({ task: "rephrase", text: "x".repeat(MAX_ASSIST_CHARS + 1) })).status).toBe(422);
    expect((await post({ task: "rephrase", text: "" })).status).toBe(400);
    expect((await post({ task: "rephrase", text: "   \n " })).status).toBe(400);
    expect((await post({ task: "write_poem", text: "hello" })).status).toBe(422);
    expect((await post({ task: "translate", text: "hello" })).status).toBe(400);
    expect((await post({ task: "translate", text: "hello", targetLanguage: "  " })).status).toBe(400);
    expect(model.doGenerateCalls).toHaveLength(1);
  });
});

test.concurrent("refuses unauthenticated, non-member, and Guest requests without calling the model", async () => {
  await withRollback(db, async (tx) => {
    const { call, workspace, join, signUp, model } = await setup(tx);
    const body = { workspaceId: workspace.id, task: "rephrase", text: "hello" };
    expect((await call("/api/ai/assist", body)).status).toBe(401);
    expect((await call("/api/ai/assist", body, await signUp("Outsider"))).status).toBe(403);
    expect((await call("/api/ai/assist", body, await join("Guest"))).status).toBe(403);
    expect(model.doGenerateCalls).toHaveLength(0);
  });
});

test.concurrent("rate limit answers 429 with Retry-After per user and recovers", async () => {
  await withRollback(db, async (tx) => {
    let clock = 1_000_000;
    const { call, workspace, join } = await setup(tx, { limit: 2, now: () => clock });
    const alice = await join("Member");
    const bob = await join("Member");
    const body = { workspaceId: workspace.id, task: "rephrase", text: "hello" };
    expect((await call("/api/ai/assist", body, alice)).status).toBe(200);
    expect((await call("/api/ai/assist", body, alice)).status).toBe(200);
    const limited = await call("/api/ai/assist", body, alice);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await limited.json()).toMatchObject({ code: "rate_limited" });
    expect((await call("/api/ai/assist", body, bob)).status).toBe(200);
    clock += 61_000;
    expect((await call("/api/ai/assist", body, alice)).status).toBe(200);
  });
});

test.concurrent("a provider failure returns a generic error with no provider detail", async () => {
  await withRollback(db, async (tx) => {
    const failing = new MockLanguageModelV4({ doGenerate: async () => { throw new Error("sk-secret-key quota exceeded at api.provider.test"); } });
    const { call, workspace, join } = await setup(tx, { model: failing });
    const member = await join("Member");
    const original = console.error;
    const logged: unknown[][] = [];
    console.error = (...args: unknown[]) => { logged.push(args); };
    try {
      const response = await call("/api/ai/assist", { workspaceId: workspace.id, task: "rephrase", text: "hello" }, member);
      expect(response.status).toBe(502);
      const text = await response.text();
      expect(text).not.toContain("sk-secret-key");
      expect(text).not.toContain("provider.test");
      expect(logged.flat().map(String).join(" ")).toContain("sk-secret-key");
    } finally { console.error = original; }
  });
});

test.concurrent("status reports provider, model, and key presence to any member, and never the key", async () => {
  await withRollback(db, async (tx) => {
    const secret = "sk-super-secret-value";
    const app = (env: Record<string, string>) => createApp(undefined, tx, undefined, textModel(), undefined, { aiEnv: env });
    const env = { AI_PROVIDER: "anthropic", AI_MODEL: "claude-test", ANTHROPIC_API_KEY: secret, OPENAI_API_KEY: "sk-other-secret" };
    const configured = app(env);
    const call = (target: typeof configured, path: string, body: unknown, cookie?: string) => target.handle(new Request(`http://localhost${path}`, {
      method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body),
    }));
    const signUp = async (name: string) => (await call(configured, "/api/auth/sign-up/email", { name, email: `${crypto.randomUUID()}@example.test`, password: "a-secure-password" })).headers.get("set-cookie")!.split(";")[0]!;
    const admin = await signUp("Admin");
    const workspace = await (await call(configured, "/actions/create_workspace", { name: "Team", slug: `t-${crypto.randomUUID()}` }, admin)).json() as { id: string };
    const invite = await (await call(configured, "/actions/create_invite", { workspaceId: workspace.id, role: "Guest" }, admin)).json() as { token: string };
    const guest = await signUp("Guest");
    await call(configured, "/actions/accept_invite", { token: invite.token }, guest);
    const outsider = await signUp("Outsider");

    for (const cookie of [admin, guest]) {
      const response = await call(configured, "/api/ai/status", { workspaceId: workspace.id }, cookie);
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(JSON.parse(text)).toEqual({ provider: "anthropic", model: "claude-test", key: "present", configured: true });
      expect(text).not.toContain(secret);
      expect(text).not.toContain("sk-other-secret");
    }
    expect((await call(configured, "/api/ai/status", { workspaceId: workspace.id })).status).toBe(401);
    expect((await call(configured, "/api/ai/status", { workspaceId: workspace.id }, outsider)).status).toBe(403);

    const missing = await (await call(app({ AI_PROVIDER: "openai", ANTHROPIC_API_KEY: secret }), "/api/ai/status", { workspaceId: workspace.id }, admin)).json();
    expect(missing).toEqual({ provider: "openai", model: "gpt-6-luna", key: "missing", configured: false });
    const blank = await (await call(app({ OPENAI_API_KEY: "  " }), "/api/ai/status", { workspaceId: workspace.id }, admin)).json();
    expect(blank).toMatchObject({ key: "missing", configured: false });
    const unsupported = await (await call(app({ AI_PROVIDER: "other", OPENAI_API_KEY: secret }), "/api/ai/status", { workspaceId: workspace.id }, admin)).text();
    expect(JSON.parse(unsupported)).toMatchObject({ provider: "other", key: "missing", configured: false });
    expect(unsupported).not.toContain(secret);
  });
});
