import { afterAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { activities, agents, createDatabase, runtimeProfiles, runtimes, workspaceMembers, workspaces, type Database } from "@weft/db";
import { createAgentActions, createApiTokenActions, createProjectActions, createRuntimeActions, createRuntimeDispatchActions, createWorkItemActions } from "@weft/actions";
import { withRollback } from "../../../packages/db/src/test-helpers";
import { createApp } from "../src/app";

const { client, db } = createDatabase();
afterAll(async () => client.end());

/** One app with a clock the test moves by hand: offline time and freshness read it. */
function harness(transaction: Database, start: string) {
  const clock = { at: Date.parse(start) };
  const now = () => new Date(clock.at);
  const app = createApp(undefined, transaction, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, now);
  const post = (path: string, body: unknown, cookie?: string, token?: string) => app.handle(new Request(`http://localhost${path}`, {
    method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
  }));
  const signUp = async () => {
    const response = await post("/api/auth/sign-up/email", { name: "Dev", email: `${crypto.randomUUID()}@example.test`, password: "a-secure-password" });
    const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
    const me = await (await app.handle(new Request("http://localhost/api/me", { headers: { cookie } }))).json() as { user: { id: string } };
    return { cookie, id: me.user.id };
  };
  return { app, clock, now, post, signUp };
}

type ListedRuntime = {
  id: string; online: boolean; agentCli: string;
  agents: Array<{ id: string; name: string; enabled: boolean }>; unfinishedRuns: number;
};

async function listRuntimes(app: ReturnType<typeof harness>["app"], cookie: string, workspaceId: string) {
  const response = await app.handle(new Request("http://localhost/actions/list_runtimes", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ workspaceId }) }));
  return await response.json() as ListedRuntime[];
}

/** A workspace with one owner whose Daemon registered claude and codex Runtimes, the claude one shared with the workspace. */
async function setUp(transaction: Database, now: () => Date, post: ReturnType<typeof harness>["post"], signUp: ReturnType<typeof harness>["signUp"]) {
  const owner = await signUp();
  const workspace = await (await post("/actions/create_workspace", { name: "Team", slug: `del-${crypto.randomUUID()}` }, owner.cookie)).json() as { id: string };
  await transaction.update(workspaces).set({ allowAutopilot: true }).where(eq(workspaces.id, workspace.id));
  const token = await createApiTokenActions(transaction).createApiToken.handler({ userId: owner.id }, { name: "daemon" });
  const registered = await createRuntimeActions(transaction, now).registerDaemon.handler({ userId: owner.id, apiTokenId: token.id }, { hostname: "devbox", version: "1", agentClis: ["claude", "codex"] });
  const runtime = registered.runtimes.find((candidate) => candidate.agentCli === "claude")!;
  await createRuntimeActions(transaction, now).shareRuntime.handler({ userId: owner.id }, { runtimeId: runtime.id });
  return { owner, workspace, daemonId: registered.daemonId, runtime, codexRuntime: registered.runtimes.find((candidate) => candidate.agentCli === "codex")! };
}

async function bindCoder(transaction: Database, owner: { id: string }, workspaceId: string, runtimeId: string) {
  const coder = await createAgentActions(transaction).createAgent.handler({ userId: owner.id }, { workspaceId, name: "Coder", model: "default", runtimeId });
  await createAgentActions(transaction).setAgentProjectAccess.handler({ userId: owner.id }, { agentId: coder.id, allProjects: true, projectIds: [] });
  await createAgentActions(transaction).setAgentAccess.handler({ userId: owner.id }, { agentId: coder.id, userIds: [owner.id] });
  return coder;
}

test.concurrent("the owner deletes an idle offline Runtime: its profiles go, the other CLI stays, and the audit records who and what", async () => {
  await withRollback(db, async (transaction) => {
    const { app, clock, now, post, signUp } = harness(transaction, "2026-11-18T09:00:00.000Z");
    const { owner, workspace, runtime, codexRuntime } = await setUp(transaction, now, post, signUp);
    await createRuntimeActions(transaction, now).createRuntimeProfile.handler({ userId: owner.id }, { runtimeId: runtime.id, name: "Read only", sandbox: "read-only", filesystemAllowlist: [], networkAllowlist: [] });
    clock.at += 200_000;
    const response = await post("/actions/delete_runtime", { runtimeId: runtime.id }, owner.cookie);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: true });
    const listed = await listRuntimes(app, owner.cookie, workspace.id);
    expect(listed.map((candidate) => candidate.id)).toEqual([codexRuntime.id]);
    expect(await transaction.select().from(runtimeProfiles).where(eq(runtimeProfiles.runtimeId, runtime.id))).toEqual([]);
    const [entry] = await transaction.select().from(activities).where(and(eq(activities.entityType, "runtime"), eq(activities.entityId, runtime.id), eq(activities.field, "deleted")));
    expect(entry).toMatchObject({ workspaceId: workspace.id, actorId: owner.id, newValue: null, oldValue: { ownerId: owner.id, agentCli: "claude", hostname: "devbox" } });
  });
});

test.concurrent("an enabled bound Agent refuses the delete with 409, and the list names that Agent", async () => {
  await withRollback(db, async (transaction) => {
    const { app, clock, now, post, signUp } = harness(transaction, "2026-11-18T09:00:00.000Z");
    const { owner, workspace, runtime } = await setUp(transaction, now, post, signUp);
    await bindCoder(transaction, owner, workspace.id, runtime.id);
    clock.at += 200_000;
    const response = await post("/actions/delete_runtime", { runtimeId: runtime.id }, owner.cookie);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "runtime_in_use" });
    const [listed] = (await listRuntimes(app, owner.cookie, workspace.id)).filter((candidate) => candidate.id === runtime.id);
    expect(listed).toMatchObject({ agents: [{ name: "Coder", enabled: true }], unfinishedRuns: 0 });
    expect(await transaction.select({ id: runtimes.id }).from(runtimes).where(eq(runtimes.id, runtime.id))).toHaveLength(1);
  });
});

test.concurrent("a queued Run refuses the delete and is counted, even when its Agent is disabled", async () => {
  await withRollback(db, async (transaction) => {
    const { app, clock, now, post, signUp } = harness(transaction, "2026-11-18T09:00:00.000Z");
    const { owner, workspace, runtime } = await setUp(transaction, now, post, signUp);
    const coder = await bindCoder(transaction, owner, workspace.id, runtime.id);
    const project = await createProjectActions(transaction).createProject.handler({ userId: owner.id }, { workspaceId: workspace.id, name: "Alpha", key: "ALP", visibility: "public" });
    await createWorkItemActions(transaction).createWorkItem.handler({ userId: owner.id }, { projectId: project.id, title: "Waiting task", assigneeIds: [coder.userId] });
    // Disabling through the action would cancel the Run; a raw update leaves it queued, which is the case under test.
    await transaction.update(agents).set({ enabled: false }).where(eq(agents.id, coder.id));
    clock.at += 200_000;
    const response = await post("/actions/delete_runtime", { runtimeId: runtime.id }, owner.cookie);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "runtime_in_use" });
    const [listed] = (await listRuntimes(app, owner.cookie, workspace.id)).filter((candidate) => candidate.id === runtime.id);
    expect(listed).toMatchObject({ agents: [{ name: "Coder", enabled: false }], unfinishedRuns: 1 });
    expect(await transaction.select({ id: runtimes.id }).from(runtimes).where(eq(runtimes.id, runtime.id))).toHaveLength(1);
  });
});

test.concurrent("a claimed Run of the Runtime refuses the delete even after its Agent is disabled", async () => {
  await withRollback(db, async (transaction) => {
    const { app, clock, now, post, signUp } = harness(transaction, "2026-11-18T09:00:00.000Z");
    const { owner, workspace, runtime, daemonId } = await setUp(transaction, now, post, signUp);
    const coder = await bindCoder(transaction, owner, workspace.id, runtime.id);
    const project = await createProjectActions(transaction).createProject.handler({ userId: owner.id }, { workspaceId: workspace.id, name: "Alpha", key: "ALP", visibility: "public" });
    await createWorkItemActions(transaction).createWorkItem.handler({ userId: owner.id }, { projectId: project.id, title: "Claimed task", assigneeIds: [coder.userId] });
    clock.at += 10_000;
    const [claimed] = await createRuntimeDispatchActions(transaction, now).claimRuns({ userId: owner.id, daemonId }, 20);
    expect(claimed).toBeDefined();
    await transaction.update(agents).set({ enabled: false }).where(eq(agents.id, coder.id));
    const response = await post("/actions/delete_runtime", { runtimeId: runtime.id }, owner.cookie);
    expect(response.status).toBe(409);
    const [listed] = (await listRuntimes(app, owner.cookie, workspace.id)).filter((candidate) => candidate.id === runtime.id);
    expect(listed).toMatchObject({ unfinishedRuns: 1 });
  });
});

test.concurrent("a disabled bound Agent does not block the delete: its binding and Autopilot are cleared, and enabling it later keeps it off the server Autopilot", async () => {
  await withRollback(db, async (transaction) => {
    const { clock, now, post, signUp } = harness(transaction, "2026-11-18T09:00:00.000Z");
    const { owner, workspace, runtime } = await setUp(transaction, now, post, signUp);
    const coder = await bindCoder(transaction, owner, workspace.id, runtime.id);
    await createAgentActions(transaction).disableAgent.handler({ userId: owner.id }, { agentId: coder.id });
    const [before] = await transaction.select({ autopilot: agents.autopilot }).from(agents).where(eq(agents.id, coder.id));
    expect(before!.autopilot).toBe(true);
    clock.at += 200_000;
    const response = await post("/actions/delete_runtime", { runtimeId: runtime.id }, owner.cookie);
    expect(response.status).toBe(200);
    const [cleared] = await transaction.select({ runtimeId: agents.runtimeId, autopilot: agents.autopilot, enabled: agents.enabled }).from(agents).where(eq(agents.id, coder.id));
    expect(cleared).toEqual({ runtimeId: null, autopilot: false, enabled: false });
    const [entry] = await transaction.select().from(activities).where(and(eq(activities.entityType, "agent"), eq(activities.entityId, coder.id), eq(activities.field, "runtime")));
    expect(entry).toMatchObject({ oldValue: runtime.id, newValue: null, actorId: owner.id });
    await createAgentActions(transaction).enableAgent.handler({ userId: owner.id }, { agentId: coder.id });
    const enabled = await createAgentActions(transaction).getAgent.handler({ userId: owner.id }, { agentId: coder.id });
    expect(enabled).toMatchObject({ enabled: true, runtimeId: null, autopilot: false });
  });
});

test.concurrent("a member who is neither the owner nor an Admin gets 403 and the Runtime stays; a workspace Admin may delete it", async () => {
  await withRollback(db, async (transaction) => {
    const { app, clock, now, post, signUp } = harness(transaction, "2026-11-18T09:00:00.000Z");
    const { owner, workspace, runtime } = await setUp(transaction, now, post, signUp);
    const member = await signUp();
    const admin = await signUp();
    await transaction.insert(workspaceMembers).values({ workspaceId: workspace.id, userId: member.id, role: "Member" });
    await transaction.insert(workspaceMembers).values({ workspaceId: workspace.id, userId: admin.id, role: "Admin" });
    clock.at += 200_000;
    const refused = await post("/actions/delete_runtime", { runtimeId: runtime.id }, member.cookie);
    expect(refused.status).toBe(403);
    expect((await listRuntimes(app, owner.cookie, workspace.id)).map((candidate) => candidate.id)).toContain(runtime.id);
    const allowed = await post("/actions/delete_runtime", { runtimeId: runtime.id }, admin.cookie);
    expect(allowed.status).toBe(200);
    expect((await listRuntimes(app, owner.cookie, workspace.id)).map((candidate) => candidate.id)).not.toContain(runtime.id);
    const [entry] = await transaction.select({ actorId: activities.actorId }).from(activities).where(and(eq(activities.entityType, "runtime"), eq(activities.entityId, runtime.id), eq(activities.field, "deleted")));
    expect(entry).toEqual({ actorId: admin.id });
  });
});
