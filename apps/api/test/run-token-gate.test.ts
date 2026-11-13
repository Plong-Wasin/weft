import { afterAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { comments as commentRows, createDatabase, runs, type Database } from "@weft/db";
import { createAgentActions, createCommentActions, createProjectActions, createRuntimeActions, createTriggerActions, createWorkItemActions } from "@weft/actions";
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
  const personal = await (await post("/actions/create_api_token", { name: "cli" }, { cookie })).json() as { token: string };
  const project = await createProjectActions(transaction).createProject.handler({ userId: owner.id }, { workspaceId: workspace.id, name: "Gate", key: `GT${crypto.randomUUID().slice(0, 4).toUpperCase()}`, visibility: "private" });
  const agents = createAgentActions(transaction);
  const agent = await agents.createAgent.handler({ userId: owner.id }, { workspaceId: workspace.id, name: "Runtime Agent", instructions: "Work", model: "default" });
  await agents.setAgentProjectAccess.handler({ userId: owner.id }, { agentId: agent.id, allProjects: true, projectIds: [] });
  const registration = await (await post("/actions/register_daemon", { hostname: "gate", version: "1", agentClis: ["claude"] }, { token: personal.token })).json() as { runtimes: Array<{ id: string }>; daemonToken: string };
  const runtimeId = registration.runtimes[0]!.id;
  await createRuntimeActions(transaction).shareRuntime.handler({ userId: owner.id }, { runtimeId });
  await agents.updateAgent.handler({ userId: owner.id }, { agentId: agent.id, runtimeId });
  const work = createWorkItemActions(transaction);
  const item = await work.createWorkItem.handler({ userId: owner.id }, { projectId: project.id, title: "Gate item", assigneeIds: [agent.userId] });
  // Runs are claimed with the Daemon credential that registration issued, not with the Personal token.
  const claim = () => post("/api/daemon/runs/claim", {}, { token: registration.daemonToken });
  return { app, post, owner, workspace, project, agent, item, work, claim, agents };
}

test.concurrent("a Runtime Run token refuses deletes with a clear message", async () => {
  await withRollback(db, async (transaction) => {
    const { post, claim, item, agent, workspace } = await scenario(transaction);
    const [claimed] = await (await claim()).json() as Array<{ token: string }>;
    expect(claimed?.token).toStartWith("weft_run_");
    const token = claimed!.token;
    const deletion = await post("/actions/delete_work_item", { workItemId: item.id }, { token });
    expect(deletion.status).toBe(403);
    expect(await deletion.json()).toEqual({ error: "Agents cannot delete anything" });
    expect((await post("/actions/delete_agent", { agentId: agent.id }, { token })).status).toBe(403);
    // a safe write still works and really changes the item
    expect((await post("/actions/update_work_item", { workItemId: item.id, title: "Renamed" }, { token })).status).toBe(200);
    const stored = await (await post("/actions/get_work_item", { workspaceId: workspace.id, displayId: item.displayId }, { token })).json() as { title: string };
    expect(stored.title).toBe("Renamed");
  });
});

test.concurrent("Code-capable Agent access blocks a project Member until the Runtime owner grants it", async () => {
  await withRollback(db, async (transaction) => {
    const { app, post, owner, workspace, project, agent, item, agents, work } = await scenario(transaction);
    const pmId = `pm-${crypto.randomUUID()}`;
    await transaction.insert((await import("@weft/db")).users).values({ id: pmId, name: "PM", email: `${pmId}@example.test` });
    await transaction.insert((await import("@weft/db")).workspaceMembers).values({ workspaceId: workspace.id, userId: pmId, role: "Member" });
    await transaction.insert((await import("@weft/db")).projectMembers).values({ workspaceId: workspace.id, projectId: project.id, userId: pmId, role: "Member" });
    const serverAgent = await agents.createAgent.handler({ userId: owner.id }, { workspaceId: workspace.id, name: "Server Agent", instructions: "Reply", model: "default" });
    await agents.setAgentProjectAccess.handler({ userId: owner.id }, { agentId: serverAgent.id, allProjects: false, projectIds: [project.id] });
    expect(serverAgent.runtimeId).toBeNull();
    expect((await agents.getAgent.handler({ userId: owner.id }, { agentId: serverAgent.id })).accessUserIds).toEqual([owner.id, pmId].sort());
    await expect(agents.setAgentAccess.handler({ userId: pmId }, { agentId: serverAgent.id, userIds: [] })).rejects.toThrow("Admin");
    const adminAccess = await agents.setAgentAccess.handler({ userId: owner.id }, { agentId: serverAgent.id, userIds: [pmId] });
    expect(adminAccess.accessUserIds).toEqual([pmId]);
    expect((await agents.getAgent.handler({ userId: owner.id }, { agentId: agent.id })).accessUserIds).toEqual([owner.id]);
    await expect(work.createWorkItem.handler({ userId: pmId }, { projectId: project.id, title: "Blocked assignment", assigneeIds: [agent.userId] })).rejects.toThrow("Agent access");
    expect((await transaction.select({ id: runs.id }).from(runs)).length).toBe(1);
    const comments = createCommentActions(transaction);
    await comments.createComment.handler({ userId: pmId }, { workItemId: item.id, body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "A plain comment does not wake the assigned Agent." }] }] } });
    expect((await transaction.select({ id: runs.id }).from(runs)).length).toBe(1);
    await expect(comments.createComment.handler({ userId: pmId }, { workItemId: item.id, body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "mention", attrs: { id: agent.userId, label: agent.name } }] }] } })).rejects.toThrow("Agent access");
    expect((await transaction.select({ id: runs.id }).from(runs)).length).toBe(1);
    await createTriggerActions(transaction).createTrigger.handler({ userId: owner.id }, { agentId: agent.id, projectId: project.id, eventType: "work_item_updated" });
    await work.updateWorkItem.handler({ userId: pmId }, { workItemId: item.id, title: "PM update does not fire an inaccessible Agent" });
    expect((await transaction.select({ id: runs.id }).from(runs)).length).toBe(1);
    await expect(agents.setAgentAccess.handler({ userId: pmId }, { agentId: agent.id, userIds: [pmId] })).rejects.toThrow("Runtime owner");
    const granted = await agents.setAgentAccess.handler({ userId: owner.id }, { agentId: agent.id, userIds: [owner.id, pmId] });
    expect(granted.accessUserIds).toEqual([owner.id, pmId].sort());
    await agents.setAgentAccess.handler({ userId: owner.id }, { agentId: agent.id, userIds: [owner.id] });
    await expect(work.createWorkItem.handler({ userId: pmId }, { projectId: project.id, title: "Revoked assignment", assigneeIds: [agent.userId] })).rejects.toThrow("Agent access");
    const restored = await agents.setAgentAccess.handler({ userId: owner.id }, { agentId: agent.id, userIds: [owner.id, pmId] });
    expect(restored.accessUserIds).toContain(pmId);
    await work.createWorkItem.handler({ userId: pmId }, { projectId: project.id, title: "Allowed assignment", assigneeIds: [agent.userId] });
    expect((await transaction.select({ id: runs.id }).from(runs)).length).toBe(2);

    const signUp = await post("/api/auth/sign-up/email", { name: "PM API", email: `${crypto.randomUUID()}@example.test`, password: "a-secure-password" });
    const pmCookie = signUp.headers.get("set-cookie")!.split(";")[0]!;
    const pmMe = await (await app.handle(new Request("http://localhost/api/me", { headers: { cookie: pmCookie } }))).json() as { user: { id: string } };
    await transaction.insert((await import("@weft/db")).workspaceMembers).values({ workspaceId: workspace.id, userId: pmMe.user.id, role: "Member" });
    await transaction.insert((await import("@weft/db")).projectMembers).values({ workspaceId: workspace.id, projectId: project.id, userId: pmMe.user.id, role: "Member" });
    const itemForNote = await work.createWorkItem.handler({ userId: owner.id }, { projectId: project.id, title: "API refusal note" });
    const apiRefusal = await post("/actions/update_work_item", { workItemId: itemForNote.id, assigneeIds: [agent.userId] }, { cookie: pmCookie });
    expect(apiRefusal.status).toBe(403);
    const notes = await transaction.select({ bodyText: commentRows.bodyText }).from(commentRows).where(eq(commentRows.workItemId, itemForNote.id));
    expect(notes.some((row) => row.bodyText.includes("did not start a Run"))).toBe(true);
  });
});

test.concurrent("a Runtime Run token gets only the baseline writes until an Admin grants extra action groups", async () => {
  await withRollback(db, async (transaction) => {
    const { post, claim, owner, workspace, project, agent, agents } = await scenario(transaction);
    const [claimed] = await (await claim()).json() as Array<{ token: string }>;
    const token = claimed!.token;
    expect((await post("/actions/create_project", { workspaceId: workspace.id, name: "Denied", key: "DND", visibility: "private" }, { token })).status).toBe(403);
    const cycleInput = { projectId: project.id, name: "Cycle", startDate: "2026-11-01", endDate: "2026-11-30" };
    expect((await post("/actions/create_cycle", cycleInput, { token })).status).toBe(403);
    expect((await post("/actions/request_export", { workspaceId: workspace.id, projectIds: [project.id] }, { token })).status).toBe(403);
    await agents.updateAgent.handler({ userId: owner.id }, { agentId: agent.id, allowProjectActions: true, allowFeatureActions: true, allowExportActions: true });
    expect((await post("/actions/create_project", { workspaceId: workspace.id, name: "Allowed", key: `AL${crypto.randomUUID().slice(0, 4).toUpperCase()}`, visibility: "private" }, { token })).status).toBe(200);
    expect((await post("/actions/create_cycle", cycleInput, { token })).status).toBe(200);
    expect((await post("/actions/request_export", { workspaceId: workspace.id, projectIds: [project.id] }, { token })).status).toBe(200);
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
    await post("/actions/update_work_item", { workItemId: item.id, title: "Changed by an agent" }, { token });
    await post("/actions/create_comment", { workItemId: item.id, body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "from agent" }] }] } }, { token });
    expect((await transaction.select({ id: runs.id }).from(runs)).length).toBe(before);
  });
});

test.concurrent("turning off allow Autopilot stops new Runtime Runs and ends the authority of Run tokens already issued", async () => {
  await withRollback(db, async (transaction) => {
    const { post, claim, owner, workspace, item } = await scenario(transaction);
    const [claimed] = await (await claim()).json() as Array<{ token: string }>;
    await post("/actions/set_autopilot_setting", { workspaceId: workspace.id, allowAutopilot: false }, { cookie: owner.cookie });
    expect((await post("/actions/update_work_item", { workItemId: item.id, title: "After switch off" }, { token: claimed!.token })).status).toBe(401);
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
    const daemonToken = await (await post("/actions/create_api_token", { name: "cli-2" }, { cookie: owner.cookie })).json() as { token: string };
    app.listen(0);
    try {
      // Re-register on a second Daemon, bind a second Agent to its Runtime, then connect.
      const registration = await (await post("/actions/register_daemon", { hostname: "second", version: "1", agentClis: ["codex"] }, { token: daemonToken.token })).json() as { runtimes: Array<{ id: string }>; daemonToken: string };
      const runtimeId = registration.runtimes[0]!.id;
      await createRuntimeActions(transaction).shareRuntime.handler({ userId: owner.id }, { runtimeId });
      const agents = createAgentActions(transaction);
      const second = await agents.createAgent.handler({ userId: owner.id }, { workspaceId: agent.workspaceId, name: "Second", instructions: "Work", model: "default" });
      await agents.setAgentProjectAccess.handler({ userId: owner.id }, { agentId: second.id, allProjects: true, projectIds: [] });
      await agents.updateAgent.handler({ userId: owner.id }, { agentId: second.id, runtimeId });
      const ws = new WebSocket(`ws://localhost:${app.server!.port}/api/daemon?token=${encodeURIComponent(registration.daemonToken)}`);
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

test.concurrent("a Run token cannot rewrite Skills, create workspaces, export data, read AI-hidden data, or act in another workspace", async () => {
  await withRollback(db, async (transaction) => {
    const { post, claim, owner } = await scenario(transaction);
    const other = await (await post("/actions/create_workspace", { name: "Other", slug: `other-${crypto.randomUUID()}` }, { cookie: owner.cookie })).json() as { id: string };
    const [claimed] = await (await claim()).json() as Array<{ token: string }>;
    const token = claimed!.token;
    expect((await post("/actions/create_skill", { workspaceId: other.id, scope: "workspace", name: "evil", description: "d", instructions: "i" }, { token })).status).toBe(403);
    expect((await post("/actions/create_workspace", { name: "Mine", slug: `mine-${crypto.randomUUID()}` }, { token })).status).toBe(403);
    expect((await post("/actions/request_export", { workspaceId: other.id }, { token })).status).toBe(403);
    expect((await post("/actions/list_api_tokens", {}, { token })).status).toBe(403);
    expect((await post("/actions/create_project", { workspaceId: other.id, name: "Elsewhere", key: "ELS", visibility: "private" }, { token })).status).toBe(403);
  });
});

test.concurrent("a work item moved or accepted from Intake by a person fires its Triggers, by an Agent does not", async () => {
  await withRollback(db, async (transaction) => {
    const { post, owner, project, agent, item, work } = await scenario(transaction);
    const second = await work.createWorkItem.handler({ userId: owner.id }, { projectId: project.id, title: "Movable" });
    const states = await work.listStates.handler({ userId: owner.id }, { projectId: project.id });
    const target = states.find((state) => state.id !== second.stateId && state.group === "completed")!;
    const triggers = createTriggerActions(transaction);
    await triggers.createTrigger.handler({ userId: owner.id }, { agentId: agent.id, projectId: project.id, eventType: "state_changed" });
    const before = (await transaction.select({ id: runs.id }).from(runs).where(eq(runs.workItemId, second.id))).length;
    await work.moveWorkItem.handler({ userId: owner.id, source: "agent", agent: { agentUserId: agent.userId, runId: (await transaction.select({ id: runs.id }).from(runs).where(eq(runs.workItemId, item.id)))[0]!.id, originatorId: owner.id } }, { workItemId: second.id, stateId: target.id });
    expect((await transaction.select({ id: runs.id }).from(runs).where(eq(runs.workItemId, second.id))).length).toBe(before);
    const third = await work.createWorkItem.handler({ userId: owner.id }, { projectId: project.id, title: "Moved by a person" });
    await work.moveWorkItem.handler({ userId: owner.id }, { workItemId: third.id, stateId: target.id });
    expect((await transaction.select({ id: runs.id }).from(runs).where(eq(runs.workItemId, third.id))).length).toBe(1);
    expect(item.id).not.toBe(third.id); expect(typeof post).toBe("function");
  });
});

test.concurrent("a Trigger stops firing once its Agent is no longer opened to the project", async () => {
  await withRollback(db, async (transaction) => {
    const { owner, project, agent, agents, work } = await scenario(transaction);
    await createTriggerActions(transaction).createTrigger.handler({ userId: owner.id }, { agentId: agent.id, projectId: project.id, eventType: "work_item_created" });
    await agents.setAgentProjectAccess.handler({ userId: owner.id }, { agentId: agent.id, allProjects: false, projectIds: [] });
    const created = await work.createWorkItem.handler({ userId: owner.id }, { projectId: project.id, title: "No longer reachable" });
    expect(await transaction.select({ id: runs.id }).from(runs).where(eq(runs.workItemId, created.id))).toHaveLength(0);
  });
});
