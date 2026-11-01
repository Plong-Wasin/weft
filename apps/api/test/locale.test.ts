import { afterAll, expect, test } from "bun:test";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { createDatabase } from "@weft/db";
import { withRollback } from "../../../packages/db/src/test-helpers";
import { createApp } from "../src/app";

const { client, db } = createDatabase();
afterAll(async () => client.end());

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
const textModel = () => new MockLanguageModelV4({
  doStream: async () => ({
    stream: simulateReadableStream({ chunks: [
      { type: "stream-start", warnings: [] }, { type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: "ok" }, { type: "text-end", id: "t" },
      { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
    ] as never[] }),
  }),
});

test.concurrent("the language setting persists per user, shows in /api/me, and steers the AI reply language", async () => {
  await withRollback(db, async (transaction) => {
    const model = textModel();
    const app = createApp(undefined, transaction, undefined, model);
    const call = async (path: string, body?: unknown, cookie?: string) => app.handle(new Request(`http://localhost${path}`, {
      method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
    const signUp = async (name: string) => (await call("/api/auth/sign-up/email", { name, email: `${crypto.randomUUID()}@example.test`, password: "a-secure-password" })).headers.get("set-cookie")!.split(";")[0]!;
    const alice = await signUp("Alice");
    const bob = await signUp("Bob");
    const workspace = await (await call("/actions/create_workspace", { name: "Team", slug: `t-${crypto.randomUUID()}` }, alice)).json() as { id: string };

    expect(((await (await call("/api/me", undefined, alice)).json()) as { user: { locale: string } }).user.locale).toBe("en");
    expect(await (await call("/actions/set_my_locale", { locale: "th" }, alice)).json()).toEqual({ locale: "th" });
    expect(((await (await call("/api/me", undefined, alice)).json()) as { user: { locale: string } }).user.locale).toBe("th");
    expect(((await (await call("/api/me", undefined, bob)).json()) as { user: { locale: string } }).user.locale).toBe("en");
    expect((await call("/actions/set_my_locale", { locale: "fr" }, alice)).status).toBe(422);

    const ask = async (cookie: string) => {
      await (await call("/api/ai/chat", { id: crypto.randomUUID(), workspaceId: workspace.id, messages: [{ id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text: "hi" }] }] }, cookie)).text();
    };
    await ask(alice);
    expect(JSON.stringify(model.doStreamCalls[0]!.prompt)).toContain("Thai");
    await call("/actions/accept_invite", { token: (await (await call("/actions/create_invite", { workspaceId: workspace.id, role: "Member" }, alice)).json() as { token: string }).token }, bob);
    await ask(bob);
    expect(JSON.stringify(model.doStreamCalls[1]!.prompt)).not.toContain("Thai");

    // the locale actions are not tools the AI may call
    const offered = (model.doStreamCalls[0]!.tools ?? []).map((entry) => (entry as { name: string }).name);
    expect(offered).not.toContain("get_my_locale");
    expect(offered).not.toContain("set_my_locale");
  });
});
