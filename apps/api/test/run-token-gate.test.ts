import { afterAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createDatabase, runs, type Database } from "@weft/db";
import { createAgentActions, createProjectActions, createRuntimeActions, createTriggerActions, createWorkItemActions } from "@weft/actions";
import { withRollback } from "../../../packages/db/src/test-helpers";
import { createApp } from "../src/app";

const { client, db } = createDatabase();
afterAll(async () => client.end());

async function scenario(transaction: Database, allowAutopilot = true) {
  const app = createApp(undefined, transaction);
  const post = (path: string, body: unknown, options: { cookie?: string; token?: string } = {}) => app.handle(new Request(`http://localhost${path}`, {
    method: "POST", headers: { "content-type": "application/json", ...(options.cookie ? { cookie: options.cookie } : {}), ...(options.token ? { authorization: `Bearer ${options.token}` } : {}) }, body: JSON.stringify(body),
  }));
  const signUp = await post("/api/auth/sign-up/email", { name: "Dev", email: `${crypto.randomUUID()}@example.test`, password: "a-secure-password" });
  const cookie = signUp.headers.get("set-cookie")!.split(";")[0]!;
  const me = await (await app.handle(new Request("http://localhost/api/me", { headers: { cookie } }))).json() as { user: { id: string } };
  const owner = { id: me.user.id, cookie };
  const workspace = await (await post("/actions/create_workspace", { name: "Team", slug: `gate-${crypto.randomUUID()}` }, { cookie })).json() as { id: string };
  if (allowAutopilot) await post("/actions/set_autopilot_setting", { workspaceId: workspace.id, allowAutopilot: true }, { cookie });
  const daemonToken = await (await post("/actions/create_api_token", { name: "daemon" }, { cookie })).json() as { token: string };
  const project = await createProjectActions(transaction).createProject.handler({ userId: owner.id }, { workspaceId: workspace.id, name: "Gate", key: `GT${crypto.randomUUID().slice(0, 4).toUpperCase()}`, visibility: "private" });
  const agents = createAgentActions(transaction);
  const agent = await agents.createAgent.handler({ userId: owner.id }, { workspaceId: workspace.id, name: "Runtime Agent", instructions: "Work", model: "default" });
  await agents.setAgentProjectAccess.handler({ userId: owner.id }, { agentId: agent.id, allProjects: true, projectIds: [] });
  const registration = await (await post("/actions/register_daemon", { hostname: "gate", version: "1", agentClis: ["claude"] }, { token: daemonToken.token })).json() as { runtimes: Array<{ id: string }> };
  const runtimeId = registration.runtimes[0]!.id;
  await createRuntimeActions(transaction).shareRuntime.handler({ userId: owner.id }, { runtimeId });
  await agents.updateAgent.handler({ userId: owner.id }, { agentId: agent.id, runtimeId });
  const work = createWorkItemActions(transaction);
  const item = await work.createWorkItem.handler({ userId: owner.id }, { projectId: project.id, title: "Gate item", assigneeIds: [agent.userId] });
  const claim = () => post("/api/daemon/runs/claim", {}, { token: daemonToken.token });
  return { app, post, owner, workspace, project, agent, item, work, claim, agents };
}

test.concurrent("a Run token cannot delete: deletes need a Confirmation an agent CLI cannot see", async () => {
  await withRollback(db, async (transaction) => {
    const { post, claim, item, agent } = await scenario(transaction);
    const [claimed] = await (await claim()).json() as Array<{ token: string }>;
    expect(claimed?.token).toStartWith("weft_run_");
    const token = claimed!.token;
    expect((await post("/actions/delete_work_item", { workItemId: item.id }, { token })).status).toBe(403);
    expect((await post("/actions/delete_agent", { agentId: agent.id }, { token })).status).toBe(403);
    // a safe write still works
    expect((await post("/actions/update_work_item", { workItemId: item.id, name: "Renamed" }, { token })).status).not.toBe(403);
  });
});

test.concurrent("changes made through a Run token fire no Trigger, for create, update and comment alike", async () => {
  await withRollback(db, async (transaction) => {
    const { post, claim, owner, project, agent, item, agents } = await scenario(transaction);
    const triggers = createTriggerActions(transaction);
    for (const eventType of ["work_item_created", "work_item_updated", "comment_added"] as const) await triggers.createTrigger.handler({ userId: owner.id }, { agentId: agent.id, projectId: project.id, eventType });
    const [claimed] = await (await claim()).json() as Array<{ token: string }>;
    const token = claimed!.token;
    const before = (await transaction.select({ id: runs.id }).from(runs)).length;
    await post("/actions/create_work_item", { projectId: project.id, title: "Made by an agent" }, { token });
    await post("/actions/update_work_item", { workItemId: item.id, name: "Changed by an agent" }, { token });
    await post("/actions/create_comment", { workItemId: item.id, body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "from agent" }] }] } }, { token });
    expect((await transaction.select({ id: runs.id }).from(runs)).length).toBe(before);
  });
});

test.concurrent("turning off allow Autopilot stops new Runtime Runs and ends the authority of Run tokens already issued", async () => {
  await withRollback(db, async (transaction) => {
    const { post, claim, owner, workspace, item } = await scenario(transaction);
    const [claimed] = await (await claim()).json() as Array<{ token: string }>;
    await post("/actions/set_autopilot_setting", { workspaceId: workspace.id, allowAutopilot: false }, { cookie: owner.cookie });
    expect((await post("/actions/update_work_item", { workItemId: item.id, name: "After switch off" }, { token: claimed!.token })).status).toBe(401);
    await transaction.update(runs).set({ status: "queued", runtimeId: null, dispatchedAt: null }).where(eq(runs.workItemId, item.id));
    expect(await (await claim()).json()).toEqual([]);
  });
});

test.concurrent("a Run token reaches only AI-allowed Writes and never the AI routes that confirm cards", async () => {
  await withRollback(db, async (transaction) => {
    const { post, claim, workspace, agent } = await scenario(transaction);
    const [claimed] = await (await claim()).json() as Array<{ token: string }>;
    const token = claimed!.token;
    expect((await post("/actions/set_autopilot_setting", { workspaceId: workspace.id, allowAutopilot: true }, { token })).status).toBe(403);
    expect((await post("/actions/update_agent", { agentId: agent.id, name: "Hijacked" }, { token })).status).toBe(403);
    expect((await post("/actions/share_runtime", { runtimeId: crypto.randomUUID() }, { token })).status).toBe(403);
    expect((await post("/api/ai/confirmations/confirm", { id: crypto.randomUUID() }, { token })).status).toBe(401);
    expect((await post("/api/ai/chats", { workspaceId: workspace.id }, { token })).status).toBe(401);
  });
});

test.concurrent("a connected Daemon is told about queued work within seconds, without waiting for its next heartbeat", async () => {
  await withRollback(db, async (transaction) => {
    const { app, post, owner, project, agent, work } = await scenario(transaction);
    const daemonToken = await (await post("/actions/create_api_token", { name: "daemon-2" }, { cookie: owner.cookie })).json() as { token: string };
    app.listen(0);
    try {
      // Re-register on a second Daemon, bind a second Agent to its Runtime, then connect.
      const registration = await (await post("/actions/register_daemon", { hostname: "second", version: "1", agentClis: ["codex"] }, { token: daemonToken.token })).json() as { runtimes: Array<{ id: string }> };
      const runtimeId = registration.runtimes[0]!.id;
      await createRuntimeActions(transaction).shareRuntime.handler({ userId: owner.id }, { runtimeId });
      const agents = createAgentActions(transaction);
      const second = await agents.createAgent.handler({ userId: owner.id }, { workspaceId: agent.workspaceId, name: "Second", instructions: "Work", model: "default" });
      await agents.setAgentProjectAccess.handler({ userId: owner.id }, { agentId: second.id, allProjects: true, projectIds: [] });
      await agents.updateAgent.handler({ userId: owner.id }, { agentId: second.id, runtimeId });
      const ws = new WebSocket(`ws://localhost:${app.server!.port}/api/daemon?token=${encodeURIComponent(daemonToken.token)}`);
      await new Promise<void>((resolve, reject) => { ws.addEventListener("open", () => resolve(), { once: true }); ws.addEventListener("error", () => reject(new Error("WebSocket failed")), { once: true }); });
      ws.send(JSON.stringify({ type: "heartbeat" }));
      await Bun.sleep(300);
      const signal = new Promise<string>((resolve) => ws.addEventListener("message", (event) => { if (String(event.data).includes("work_available")) resolve("signalled"); }));
      await work.createWorkItem.handler({ userId: owner.id }, { projectId: project.id, title: "Queued later", assigneeIds: [second.userId] });
      expect(await Promise.race([signal, Bun.sleep(5_000).then(() => "late")])).toBe("signalled");
      ws.close();
    } finally { app.stop(true); }
  });
});
