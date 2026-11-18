import { afterAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { activities, agentAccess, agents, createDatabase, jobs, runs, runtimeProfiles, runtimes, workspaceMembers, workspaces, type Database } from "@weft/db";
import { createAgentActions, createApiTokenActions, createCommentActions, createProjectActions, createRuntimeActions, createRuntimeDispatchActions, createWorkItemActions } from "@weft/actions";
import { withRollback } from "../../../packages/db/src/test-helpers";
import { createApp } from "../src/app";

const { client, db } = createDatabase();
afterAll(async () => client.end());

/** One app with a clock the test moves by hand: offline time and freshness read it. */
function harness(transaction: Database, start: string) {
  const clock = { at: Date.parse(start) };
  const now = () => new Date(clock.at);
  const app = createApp(undefined, transaction, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, now);
  const post = (path: string, body: unknown, cookie?: string) => app.handle(new Request(`http://localhost${path}`, {
    method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body),
  }));
  const signUp = async () => {
    const response = await post("/api/auth/sign-up/email", { name: "Dev", email: `${crypto.randomUUID()}@example.test`, password: "a-secure-password" });
    const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
    const me = await (await app.handle(new Request("http://localhost/api/me", { headers: { cookie } }))).json() as { user: { id: string } };
    return { cookie, id: me.user.id };
  };
  return { app, clock, now, post, signUp };
}

type Harness = ReturnType<typeof harness>;
type ListedRuntime = { id: string; workspaceId: string; ownerId: string; shared: boolean; online: boolean; agentCli: string; agents: Array<{ id: string; name: string; enabled: boolean }>; unfinishedRuns: number };

async function listRuntimes(app: Harness["app"], cookie: string, workspaceId: string) {
  const response = await app.handle(new Request("http://localhost/actions/list_runtimes", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ workspaceId }) }));
  return await response.json() as ListedRuntime[];
}

/** A workspace whose creator (an Admin) has one Daemon with a claude and a codex Runtime; the claude one is shared, the codex one is private. */
async function setUp(transaction: Database, h: Harness) {
  const owner = await h.signUp();
  const workspace = await (await h.post("/actions/create_workspace", { name: "Team", slug: `unbind-${crypto.randomUUID()}` }, owner.cookie)).json() as { id: string };
  await transaction.update(workspaces).set({ allowAutopilot: true }).where(eq(workspaces.id, workspace.id));
  const apiTokenId = (await createApiTokenActions(transaction).createApiToken.handler({ userId: owner.id }, { name: "daemon" })).id;
  const registered = await createRuntimeActions(transaction, h.now).registerDaemon.handler({ userId: owner.id, apiTokenId }, { hostname: "devbox", version: "1", agentClis: ["claude", "codex"] });
  const runtime = registered.runtimes.find((candidate) => candidate.agentCli === "claude")!;
  const codexRuntime = registered.runtimes.find((candidate) => candidate.agentCli === "codex")!;
  await createRuntimeActions(transaction, h.now).shareRuntime.handler({ userId: owner.id }, { runtimeId: runtime.id });
  const project = await createProjectActions(transaction).createProject.handler({ userId: owner.id }, { workspaceId: workspace.id, name: "Alpha", key: "ALP", visibility: "public" });
  return { owner, workspace, daemonId: registered.daemonId, runtime, codexRuntime, project, apiTokenId };
}

async function bind(transaction: Database, owner: { id: string }, workspaceId: string, runtimeId: string, name: string) {
  const agent = await createAgentActions(transaction).createAgent.handler({ userId: owner.id }, { workspaceId, name, model: "default", runtimeId });
  await createAgentActions(transaction).setAgentProjectAccess.handler({ userId: owner.id }, { agentId: agent.id, allProjects: true, projectIds: [] });
  await createAgentActions(transaction).setAgentAccess.handler({ userId: owner.id }, { agentId: agent.id, userIds: [owner.id] });
  return agent;
}

const mention = (userId: string, label = "Bot") => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "mention", attrs: { id: userId, label } }, { type: "text", text: " please look" }] }] });

/** A work item in the project that mentions the Agent, written by the owner: the mention queues a Run. */
async function mentionAgent(transaction: Database, owner: { id: string }, projectId: string, agentUserId: string, existing?: { id: string }) {
  const item = existing ?? await createWorkItemActions(transaction).createWorkItem.handler({ userId: owner.id }, { projectId, title: "Task" });
  const comment = await createCommentActions(transaction).createComment.handler({ userId: owner.id }, { workItemId: item.id, body: mention(agentUserId) });
  const [run] = await transaction.select().from(runs).where(and(eq(runs.workItemId, item.id), eq(runs.commentId, comment.id)));
  return { item, run: run! };
}

test.concurrent("an Admin unbinds the Agents and deletes the Runtime in one step: each Agent goes back to the server with Autopilot off, audited per Agent, and its next mention runs on the server", async () => {
  await withRollback(db, async (transaction) => {
    const h = harness(transaction, "2026-11-18T09:00:00.000Z");
    const { owner, workspace, runtime, project } = await setUp(transaction, h);
    const coder = await bind(transaction, owner, workspace.id, runtime.id, "Coder");
    const scout = await bind(transaction, owner, workspace.id, runtime.id, "Scout");
    await createAgentActions(transaction).disableAgent.handler({ userId: owner.id }, { agentId: scout.id });
    h.clock.at += 200_000;
    const response = await h.post("/actions/delete_runtime", { runtimeId: runtime.id, boundAgents: "unbind" }, owner.cookie);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: true });
    expect(await transaction.select({ id: runtimes.id }).from(runtimes).where(eq(runtimes.id, runtime.id))).toEqual([]);
    const rows = await transaction.select({ id: agents.id, runtimeId: agents.runtimeId, runtimeProfileId: agents.runtimeProfileId, autopilot: agents.autopilot, enabled: agents.enabled }).from(agents).where(eq(agents.workspaceId, workspace.id));
    expect(rows.find((row) => row.id === coder.id)).toEqual({ id: coder.id, runtimeId: null, runtimeProfileId: null, autopilot: false, enabled: true });
    expect(rows.find((row) => row.id === scout.id)).toEqual({ id: scout.id, runtimeId: null, runtimeProfileId: null, autopilot: false, enabled: false });
    expect((await createAgentActions(transaction).getAgent.handler({ userId: owner.id }, { agentId: coder.id }))).toMatchObject({ runtimeId: null, autopilot: false });
    for (const agent of [coder, scout]) {
      const entries = await transaction.select().from(activities).where(and(eq(activities.entityType, "agent"), eq(activities.entityId, agent.id), eq(activities.field, "runtime")));
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ actorId: owner.id, oldValue: runtime.id, newValue: null });
    }
    const deleted = await transaction.select().from(activities).where(and(eq(activities.entityType, "runtime"), eq(activities.entityId, runtime.id), eq(activities.field, "deleted")));
    expect(deleted).toHaveLength(1);
    // The Weft server runs the next mention of the unbound Agent: a queued Run with no Runtime, and a job for the server worker.
    const { run } = await mentionAgent(transaction, owner, project.id, coder.userId);
    expect(run).toMatchObject({ status: "queued", agentId: coder.id, runtimeId: null });
    expect((await transaction.select().from(jobs)).some((job) => job.type === "agent_run" && (job.payload as { runId: string }).runId === run.id)).toBe(true);
  });
});

test.concurrent("an Admin moves the Agents to another shared Runtime and deletes: each Agent keeps running there in a new Session, audited, and keeps its enabled state", async () => {
  await withRollback(db, async (transaction) => {
    const h = harness(transaction, "2026-11-18T09:00:00.000Z");
    const { owner, workspace, runtime, codexRuntime, project, daemonId } = await setUp(transaction, h);
    const coder = await bind(transaction, owner, workspace.id, runtime.id, "Coder");
    const scout = await bind(transaction, owner, workspace.id, runtime.id, "Scout");
    await createAgentActions(transaction).disableAgent.handler({ userId: owner.id }, { agentId: scout.id });
    // The Agent has an earlier finished Run on the old Runtime with a CLI Session: the next Run must not resume it.
    const earlier = await mentionAgent(transaction, owner, project.id, coder.userId);
    await transaction.update(runs).set({ status: "completed", runtimeId: runtime.id, cliSessionId: "old-session", sessionFolder: "old-folder", dispatchedAt: new Date() }).where(eq(runs.id, earlier.run.id));
    await createRuntimeActions(transaction, h.now).shareRuntime.handler({ userId: owner.id }, { runtimeId: codexRuntime.id });
    h.clock.at += 200_000;
    const response = await h.post("/actions/delete_runtime", { runtimeId: runtime.id, boundAgents: { moveTo: codexRuntime.id } }, owner.cookie);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: true });
    const [fullProfile] = await transaction.select({ id: runtimeProfiles.id }).from(runtimeProfiles).where(and(eq(runtimeProfiles.runtimeId, codexRuntime.id), eq(runtimeProfiles.sandbox, "full")));
    const moved = await transaction.select({ id: agents.id, runtimeId: agents.runtimeId, runtimeProfileId: agents.runtimeProfileId, autopilot: agents.autopilot, enabled: agents.enabled }).from(agents).where(eq(agents.workspaceId, workspace.id));
    expect(moved.find((row) => row.id === coder.id)).toEqual({ id: coder.id, runtimeId: codexRuntime.id, runtimeProfileId: fullProfile!.id, autopilot: true, enabled: true });
    expect(moved.find((row) => row.id === scout.id)).toEqual({ id: scout.id, runtimeId: codexRuntime.id, runtimeProfileId: fullProfile!.id, autopilot: true, enabled: false });
    for (const agent of [coder, scout]) {
      const entries = await transaction.select().from(activities).where(and(eq(activities.entityType, "agent"), eq(activities.entityId, agent.id), eq(activities.field, "runtime")));
      expect(entries.map((entry) => [entry.oldValue, entry.newValue])).toEqual([[runtime.id, codexRuntime.id]]);
    }
    expect(await transaction.select().from(activities).where(and(eq(activities.entityType, "runtime"), eq(activities.entityId, runtime.id), eq(activities.field, "deleted")))).toHaveLength(1);
    // The people allowed to mention the Agent stay as they were: the Runtime owner is unchanged.
    expect((await transaction.select({ userId: agentAccess.userId }).from(agentAccess).where(eq(agentAccess.agentId, coder.id))).map((row) => row.userId)).toEqual([owner.id]);
    // The next mention is claimed by the target Runtime, in a new Session that does not resume the old one.
    const next = await mentionAgent(transaction, owner, project.id, coder.userId, earlier.item);
    // The target Daemon heartbeats, so its Runtime is fresh enough to be offered Runs.
    await createRuntimeActions(transaction, h.now).heartbeat({ userId: owner.id }, daemonId);
    const claimed = await createRuntimeDispatchActions(transaction, h.now).claimRuns({ userId: owner.id, daemonId }, 20);
    const mine = claimed.find((claim) => claim.runId === next.run.id);
    expect(mine).toMatchObject({ runtimeId: codexRuntime.id, session: { resumeSessionId: null, reason: "runtime_changed" } });
    expect(mine!.session!.folder).not.toBe("old-folder");
  });
});

test.concurrent("a Runtime owner who is not an Admin gets 403 for unbind or move, and nothing changes", async () => {
  await withRollback(db, async (transaction) => {
    const h = harness(transaction, "2026-11-18T09:00:00.000Z");
    const { owner, workspace, runtime, codexRuntime } = await setUp(transaction, h);
    const coder = await bind(transaction, owner, workspace.id, runtime.id, "Coder");
    await transaction.update(workspaceMembers).set({ role: "Member" }).where(and(eq(workspaceMembers.workspaceId, workspace.id), eq(workspaceMembers.userId, owner.id)));
    h.clock.at += 200_000;
    expect((await h.post("/actions/delete_runtime", { runtimeId: runtime.id, boundAgents: "unbind" }, owner.cookie)).status).toBe(403);
    expect((await h.post("/actions/delete_runtime", { runtimeId: runtime.id, boundAgents: { moveTo: codexRuntime.id } }, owner.cookie)).status).toBe(403);
    expect(await transaction.select({ runtimeId: agents.runtimeId }).from(agents).where(eq(agents.id, coder.id))).toEqual([{ runtimeId: runtime.id }]);
    expect(await transaction.select({ id: runtimes.id }).from(runtimes).where(eq(runtimes.id, runtime.id))).toHaveLength(1);
    // Without an option the owner still gets the 409 that names the enabled Agent.
    expect((await h.post("/actions/delete_runtime", { runtimeId: runtime.id }, owner.cookie)).status).toBe(409);
  });
});

test.concurrent("a Run in flight refuses both options with the same 409 as ticket 02, and the Agent stays bound", async () => {
  await withRollback(db, async (transaction) => {
    const h = harness(transaction, "2026-11-18T09:00:00.000Z");
    const { owner, workspace, runtime, codexRuntime, project } = await setUp(transaction, h);
    const coder = await bind(transaction, owner, workspace.id, runtime.id, "Coder");
    await mentionAgent(transaction, owner, project.id, coder.userId);
    await createRuntimeActions(transaction, h.now).shareRuntime.handler({ userId: owner.id }, { runtimeId: codexRuntime.id });
    h.clock.at += 200_000;
    for (const boundAgents of ["unbind", { moveTo: codexRuntime.id }] as const) {
      const response = await h.post("/actions/delete_runtime", { runtimeId: runtime.id, boundAgents }, owner.cookie);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "runtime_in_use" });
    }
    expect(await transaction.select({ runtimeId: agents.runtimeId }).from(agents).where(eq(agents.id, coder.id))).toEqual([{ runtimeId: runtime.id }]);
    expect(await transaction.select({ id: runtimes.id }).from(runtimes).where(eq(runtimes.id, runtime.id))).toHaveLength(1);
    expect(await transaction.select().from(activities).where(and(eq(activities.entityType, "agent"), eq(activities.entityId, coder.id), eq(activities.field, "runtime")))).toEqual([]);
  });
});

test.concurrent("a move target that is private, the Runtime itself, or in another workspace is refused with 400 and nothing changes", async () => {
  await withRollback(db, async (transaction) => {
    const h = harness(transaction, "2026-11-18T09:00:00.000Z");
    const { owner, workspace, runtime, codexRuntime } = await setUp(transaction, h);
    const coder = await bind(transaction, owner, workspace.id, runtime.id, "Coder");
    // A second workspace of the same owner, and a Runtime of the owner's other Daemon shared into it.
    const other = await (await h.post("/actions/create_workspace", { name: "Other", slug: `other-${crypto.randomUUID()}` }, owner.cookie)).json() as { id: string };
    const otherToken = (await createApiTokenActions(transaction).createApiToken.handler({ userId: owner.id }, { name: "other daemon" })).id;
    const otherRegistered = await createRuntimeActions(transaction, h.now).registerDaemon.handler({ userId: owner.id, apiTokenId: otherToken }, { hostname: "otherbox", version: "1", agentClis: ["claude"] });
    const foreign = otherRegistered.runtimes.find((candidate) => candidate.workspaceId === other.id)!;
    await createRuntimeActions(transaction, h.now).shareRuntime.handler({ userId: owner.id }, { runtimeId: foreign.id });
    h.clock.at += 200_000;
    for (const moveTo of [codexRuntime.id, foreign.id, runtime.id]) {
      const response = await h.post("/actions/delete_runtime", { runtimeId: runtime.id, boundAgents: { moveTo } }, owner.cookie);
      expect(response.status).toBe(400);
    }
    expect(await transaction.select({ runtimeId: agents.runtimeId }).from(agents).where(eq(agents.id, coder.id))).toEqual([{ runtimeId: runtime.id }]);
    expect(await transaction.select({ id: runtimes.id }).from(runtimes).where(eq(runtimes.id, runtime.id))).toHaveLength(1);
    expect(await transaction.select().from(activities).where(and(eq(activities.entityType, "agent"), eq(activities.entityId, coder.id), eq(activities.field, "runtime")))).toEqual([]);
  });
});

test.concurrent("moving to a Runtime of another owner resets the people allowed to assign or mention each Agent to that owner alone", async () => {
  await withRollback(db, async (transaction) => {
    const h = harness(transaction, "2026-11-18T09:00:00.000Z");
    const { owner, workspace, runtime } = await setUp(transaction, h);
    const colleague = await h.signUp();
    await transaction.insert(workspaceMembers).values({ workspaceId: workspace.id, userId: colleague.id, role: "Member" });
    const colleagueToken = (await createApiTokenActions(transaction).createApiToken.handler({ userId: colleague.id }, { name: "colleague daemon" })).id;
    const registered = await createRuntimeActions(transaction, h.now).registerDaemon.handler({ userId: colleague.id, apiTokenId: colleagueToken }, { hostname: "colleague-box", version: "1", agentClis: ["claude"] });
    const colleagueRuntime = registered.runtimes.find((candidate) => candidate.workspaceId === workspace.id)!;
    await createRuntimeActions(transaction, h.now).shareRuntime.handler({ userId: colleague.id }, { runtimeId: colleagueRuntime.id });
    const coder = await bind(transaction, owner, workspace.id, runtime.id, "Coder");
    await createAgentActions(transaction).setAgentAccess.handler({ userId: owner.id }, { agentId: coder.id, userIds: [owner.id, colleague.id] });
    h.clock.at += 200_000;
    const response = await h.post("/actions/delete_runtime", { runtimeId: runtime.id, boundAgents: { moveTo: colleagueRuntime.id } }, owner.cookie);
    expect(response.status).toBe(200);
    expect((await transaction.select({ userId: agentAccess.userId }).from(agentAccess).where(eq(agentAccess.agentId, coder.id))).map((row) => row.userId)).toEqual([colleague.id]);
    expect(await transaction.select({ runtimeId: agents.runtimeId }).from(agents).where(eq(agents.id, coder.id))).toEqual([{ runtimeId: colleagueRuntime.id }]);
  });
});

test.concurrent("the list shows the moved Agent on the target Runtime and the deleted Runtime gone", async () => {
  await withRollback(db, async (transaction) => {
    const h = harness(transaction, "2026-11-18T09:00:00.000Z");
    const { owner, workspace, runtime, codexRuntime } = await setUp(transaction, h);
    const coder = await bind(transaction, owner, workspace.id, runtime.id, "Coder");
    await createRuntimeActions(transaction, h.now).shareRuntime.handler({ userId: owner.id }, { runtimeId: codexRuntime.id });
    h.clock.at += 200_000;
    expect((await h.post("/actions/delete_runtime", { runtimeId: runtime.id, boundAgents: { moveTo: codexRuntime.id } }, owner.cookie)).status).toBe(200);
    const listed = await listRuntimes(h.app, owner.cookie, workspace.id);
    expect(listed.map((candidate) => candidate.id)).not.toContain(runtime.id);
    expect(listed.find((candidate) => candidate.id === codexRuntime.id)?.agents).toEqual([{ id: coder.id, name: "Coder", enabled: true }]);
  });
});
