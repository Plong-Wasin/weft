import { afterAll, expect, test } from "bun:test";
import { createAgentActions, createProjectActions, createRuntimeActions, createWorkItemActions } from "@weft/actions";
import { randomUUID } from "node:crypto";
import { createDatabase, type Database } from "@weft/db";
import { withRollback } from "../../../packages/db/src/test-helpers";
import { createApp } from "../src/app";

const { client, db } = createDatabase();
afterAll(async () => client.end());

// createApp(context, db, gates, aiModel, bus, aiOptions, passwordOptions, operations, mail, authOptions, features)
const appWithAi = (tx: Database, ai: boolean) => createApp(undefined, tx, undefined, undefined, undefined, undefined, undefined, undefined, null, undefined, { ai });
const json = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test.concurrent("with AI off the config reports the switch as the cause and every /api/ai route answers 404", async () => {
  await withRollback(db, async (tx) => {
    const app = appWithAi(tx, false);
    const config = await (await app.handle(new Request("http://localhost/api/config"))).json() as { ai: { enabled: boolean; reason: string | null } };
    expect(config.ai).toEqual({ enabled: false, reason: "switched_off" });
    const signUp = await app.handle(new Request("http://localhost/api/auth/sign-up/email", { ...json({ name: "Ana", email: `${randomUUID()}@example.test`, password: "a-secure-password" }) }));
    const cookie = signUp.headers.get("set-cookie")!.split(";")[0]!;
    const workspace = await (await app.handle(new Request("http://localhost/actions/create_workspace", { ...json({ name: "Team", slug: `ai-${randomUUID()}` }), headers: { "content-type": "application/json", cookie } }))).json() as { id: string };
    for (const path of ["/api/ai/status", "/api/ai/chats", "/api/ai/assist", "/api/ai/chat"]) {
      const withCookie = await app.handle(new Request(`http://localhost${path}`, { ...json({ workspaceId: workspace.id }), headers: { "content-type": "application/json", cookie } }));
      expect(withCookie.status).toBe(404);
      const anonymous = await app.handle(new Request(`http://localhost${path}`, json({ workspaceId: workspace.id })));
      expect(anonymous.status).toBe(404);
    }
  });
});

test.concurrent("with AI on the config reports it on and /api/ai/status answers for a signed-in member", async () => {
  await withRollback(db, async (tx) => {
    const app = appWithAi(tx, true);
    const config = await (await app.handle(new Request("http://localhost/api/config"))).json() as { ai: { enabled: boolean; reason: string | null } };
    expect(config.ai).toEqual({ enabled: true, reason: null });
    const signUp = await app.handle(new Request("http://localhost/api/auth/sign-up/email", { ...json({ name: "Ben", email: `${randomUUID()}@example.test`, password: "a-secure-password" }) }));
    const cookie = signUp.headers.get("set-cookie")!.split(";")[0]!;
    const workspace = await (await app.handle(new Request("http://localhost/actions/create_workspace", { ...json({ name: "Team", slug: `ai-${randomUUID()}` }), headers: { "content-type": "application/json", cookie } }))).json() as { id: string };
    const status = await app.handle(new Request("http://localhost/api/ai/status", { ...json({ workspaceId: workspace.id }), headers: { "content-type": "application/json", cookie } }));
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ canAssist: true });
  });
});

// A Runtime Agent's Run works with its own run token and the Daemon credential, so the provider key is not needed for it.
test.concurrent("with AI off a Runtime Agent Run still claims and calls ordinary Actions with its run token", async () => {
  await withRollback(db, async (transaction) => {
    const app = createApp(undefined, transaction, undefined, undefined, undefined, undefined, undefined, undefined, null, undefined, { ai: false });
    const post = (path: string, body: unknown, options: { cookie?: string; token?: string } = {}) => app.handle(new Request(`http://localhost${path}`, {
      method: "POST", headers: { "content-type": "application/json", ...(options.cookie ? { cookie: options.cookie } : {}), ...(options.token ? { authorization: `Bearer ${options.token}` } : {}) }, body: JSON.stringify(body),
    }));
    const signUp = await post("/api/auth/sign-up/email", { name: "Dev", email: `${randomUUID()}@example.test`, password: "a-secure-password" });
    const cookie = signUp.headers.get("set-cookie")!.split(";")[0]!;
    const me = await (await app.handle(new Request("http://localhost/api/me", { headers: { cookie } }))).json() as { user: { id: string } };
    const workspace = await (await post("/actions/create_workspace", { name: "Team", slug: `run-${randomUUID()}` }, { cookie })).json() as { id: string };
    await post("/actions/set_autopilot_setting", { workspaceId: workspace.id, allowAutopilot: true }, { cookie });
    const personal = await (await post("/actions/create_api_token", { name: "cli" }, { cookie })).json() as { token: string };
    const project = await createProjectActions(transaction).createProject.handler({ userId: me.user.id }, { workspaceId: workspace.id, name: "Runs", key: `RN${randomUUID().slice(0, 4).toUpperCase()}`, visibility: "private" });
    const agents = createAgentActions(transaction);
    const agent = await agents.createAgent.handler({ userId: me.user.id }, { workspaceId: workspace.id, name: "Runtime Agent", instructions: "Work", model: "default" });
    await agents.setAgentProjectAccess.handler({ userId: me.user.id }, { agentId: agent.id, allProjects: true, projectIds: [] });
    const registration = await (await post("/actions/register_daemon", { hostname: "ai-off", version: "1", agentClis: ["claude"], capabilities: ["runtime_environment", "runtime_sandbox"] }, { token: personal.token })).json() as { runtimes: Array<{ id: string }>; daemonToken: string };
    await createRuntimeActions(transaction).shareRuntime.handler({ userId: me.user.id }, { runtimeId: registration.runtimes[0]!.id });
    await agents.updateAgent.handler({ userId: me.user.id }, { agentId: agent.id, runtimeId: registration.runtimes[0]!.id });
    const item = await createWorkItemActions(transaction).createWorkItem.handler({ userId: me.user.id }, { projectId: project.id, title: "Ran with AI off", assigneeIds: [agent.userId] });
    const [claimed] = await (await post("/api/daemon/runs/claim", {}, { token: registration.daemonToken })).json() as Array<{ token: string; workItemId: string }>;
    expect(claimed?.token).toStartWith("weft_run_");
    const read = await post("/actions/get_work_item", { workspaceId: workspace.id, displayId: item.displayId }, { token: claimed!.token });
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ id: item.id });
  });
});
