import { afterAll, expect, test } from "bun:test";
import { MockLanguageModelV4 } from "ai/test";
import { createDatabase, type Database } from "@weft/db";
import { withRollback } from "../../../packages/db/src/test-helpers";
import { createApp } from "../src/app";
import { pqlGenerationPrompt } from "../src/ai-pql";

const { client, db } = createDatabase();
afterAll(async () => client.end());

const usage = { inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 3, text: 3, reasoning: 0 } };
/** Answers with each text in turn, then repeats the last one. */
function scripted(...answers: string[]) {
  let call = 0;
  return new MockLanguageModelV4({
    doGenerate: async () => ({ content: [{ type: "text", text: answers[Math.min(call++, answers.length - 1)]! }], finishReason: { unified: "stop", raw: undefined }, usage, warnings: [] }),
  });
}

async function setup(database: Database, model: MockLanguageModelV4) {
  const app = createApp(undefined, database, undefined, model);
  const call = (path: string, body: unknown, cookie?: string) => app.handle(new Request(`http://localhost${path}`, {
    method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body),
  }));
  const signUp = async (name: string) => (await call("/api/auth/sign-up/email", { name, email: `${crypto.randomUUID()}@example.test`, password: "a-secure-password" })).headers.get("set-cookie")!.split(";")[0]!;
  const admin = await signUp("Admin");
  const workspace = await (await call("/actions/create_workspace", { name: "Team", slug: `t-${crypto.randomUUID()}` }, admin)).json() as { id: string };
  const project = await (await call("/actions/create_project", { workspaceId: workspace.id, name: "Mobile", key: "MOB", visibility: "public" }, admin)).json() as { id: string };
  await call("/actions/create_label", { projectId: project.id, name: "bug", color: "#ff0000" }, admin);
  const join = async (role: "Member" | "Guest") => {
    const invite = await (await call("/actions/create_invite", { workspaceId: workspace.id, role }, admin)).json() as { token: string };
    const cookie = await signUp(role);
    await call("/actions/accept_invite", { token: invite.token }, cookie);
    return cookie;
  };
  return { call, admin, workspace, project, join };
}

test.concurrent("returns a query that parses and resolves in the project, and shows the model the project's names", async () => {
  await withRollback(db, async (tx) => {
    const model = scripted("```pql\npriority IN (urgent, high) AND label = bug ORDER BY dueDate LIMIT 20\n```");
    const { call, admin, workspace, project } = await setup(tx, model);
    const response = await call("/api/ai/pql", { workspaceId: workspace.id, projectId: project.id, request: "urgent bugs" }, admin);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ query: "priority IN (urgent, high) AND label = bug ORDER BY dueDate LIMIT 20" });
    expect(model.doGenerateCalls).toHaveLength(1);
    const prompt = JSON.stringify(model.doGenerateCalls[0]!.prompt);
    expect(prompt).toContain("urgent bugs");
    expect(prompt).toContain("bug");
    expect(prompt).toContain("MOB");
  });
});

test.concurrent("an invalid query is fed back once with the error, and a fixed answer is returned", async () => {
  await withRollback(db, async (tx) => {
    const model = scripted("label = nosuchlabel", "label = bug");
    const { call, admin, workspace, project } = await setup(tx, model);
    const response = await call("/api/ai/pql", { workspaceId: workspace.id, projectId: project.id, request: "bugs" }, admin);
    expect(await response.json()).toEqual({ query: "label = bug" });
    expect(model.doGenerateCalls).toHaveLength(2);
    expect(JSON.stringify(model.doGenerateCalls[1]!.prompt)).toContain("nosuchlabel");
  });
});

test.concurrent("a query that is still invalid after the retry is never returned", async () => {
  await withRollback(db, async (tx) => {
    const model = scripted("label = nosuchlabel", "this is not pql (");
    const { call, admin, workspace, project } = await setup(tx, model);
    const response = await call("/api/ai/pql", { workspaceId: workspace.id, projectId: project.id, request: "bugs" }, admin);
    expect(response.status).toBe(422);
    const body = await response.json() as Record<string, unknown>;
    expect(body.code).toBe("invalid_query");
    expect(body.query).toBeUndefined();
    expect(model.doGenerateCalls).toHaveLength(2);
  });
});

test.concurrent("a project id alone is enough, and a project the caller cannot see is refused", async () => {
  await withRollback(db, async (tx) => {
    const model = scripted("label = bug");
    const { call, admin, project, join } = await setup(tx, model);
    expect(await (await call("/api/ai/pql", { projectId: project.id, request: "bugs" }, admin)).json()).toEqual({ query: "label = bug" });
    expect((await call("/api/ai/pql", { request: "bugs" }, admin)).status).toBe(400);
    const calls = model.doGenerateCalls.length;
    expect((await call("/api/ai/pql", { projectId: project.id, request: "bugs" }, await join("Guest"))).status).toBe(403);
    expect(model.doGenerateCalls).toHaveLength(calls);
  });
});

test.concurrent("works across a workspace without a project, and refuses Guests, strangers and empty requests", async () => {
  await withRollback(db, async (tx) => {
    const model = scripted("label = bug");
    const { call, admin, workspace, join } = await setup(tx, model);
    expect(await (await call("/api/ai/pql", { workspaceId: workspace.id, request: "bugs" }, admin)).json()).toEqual({ query: "label = bug" });
    const calls = model.doGenerateCalls.length;
    const body = { workspaceId: workspace.id, request: "bugs" };
    expect((await call("/api/ai/pql", body)).status).toBe(401);
    expect((await call("/api/ai/pql", body, await join("Guest"))).status).toBe(403);
    expect((await call("/api/ai/pql", { ...body, request: "   " }, admin)).status).toBe(400);
    expect(model.doGenerateCalls).toHaveLength(calls);
  });
});

test("the prompt says the request is data and asks for the query only, without web search", () => {
  const prompt = pqlGenerationPrompt({ projects: [], today: "2026-11-02" });
  expect(prompt).toContain("2026-11-02");
  expect(prompt).toMatch(/only the query/i);
  expect(prompt).not.toContain("web_search");
});
