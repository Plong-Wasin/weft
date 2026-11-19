import { afterAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { agents, createDatabase, runtimes, workspaceMembers, workspaces, type Database } from "@weft/db";
import { createAgentActions, createApiTokenActions, createProjectActions, createRuntimeActions, createRuntimeDispatchActions, createWorkItemActions } from "@weft/actions";
import { withRollback } from "../../../packages/db/src/test-helpers";
import { createApp } from "../src/app";

const { client, db } = createDatabase();
afterAll(async () => client.end());

/** One app with a clock the test moves by hand: offline time, freshness and dispatch all read it. */
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
  id: string; online: boolean; offlineSeconds: number | null;
  agents: Array<{ id: string; name: string }>; waitingRuns: number;
  sessionFolders: Array<{ folder: string; workItem: { id: string; title: string; displayId: string }; lastUsedAt: string }>;
};

async function listRuntimes(app: ReturnType<typeof harness>["app"], cookie: string, workspaceId: string) {
  const response = await app.handle(new Request("http://localhost/actions/list_runtimes", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ workspaceId }) }));
  return await response.json() as ListedRuntime[];
}

test.concurrent("the Runtime list gives seconds offline, empty while online, and nothing when the offline time is unknown", async () => {
  await withRollback(db, async (transaction) => {
    const { app, clock, post, signUp } = harness(transaction, "2026-11-18T09:00:00.000Z");
    const owner = await signUp();
    const workspace = await (await post("/actions/create_workspace", { name: "Team", slug: `use-${crypto.randomUUID()}` }, owner.cookie)).json() as { id: string };
    const token = await (await post("/actions/create_api_token", { name: "daemon" }, owner.cookie)).json() as { id: string; token: string };
    await post("/actions/register_daemon", { hostname: "devbox", version: "1", agentClis: ["claude", "codex"] }, undefined, token.token);
    const online = await listRuntimes(app, owner.cookie, workspace.id);
    expect(online.map((runtime) => [runtime.online, runtime.offlineSeconds])).toEqual([[true, null], [true, null]]);
    clock.at += 200_000;
    const offline = await listRuntimes(app, owner.cookie, workspace.id);
    expect(offline.map((runtime) => [runtime.online, runtime.offlineSeconds])).toEqual([[false, 200], [false, 200]]);
    // A Daemon that stopped resets its Runtimes to the epoch: the time it went offline is not known, so no count is shown.
    await transaction.update(runtimes).set({ lastSeenAt: new Date(0) }).where(eq(runtimes.workspaceId, workspace.id));
    const unknown = await listRuntimes(app, owner.cookie, workspace.id);
    expect(unknown.map((runtime) => [runtime.online, runtime.offlineSeconds])).toEqual([[false, null], [false, null]]);
  });
});

test.concurrent("the Runtime list names the Agents bound to it and counts the Runs that wait for an offline Runtime", async () => {
  await withRollback(db, async (transaction) => {
    const { app, clock, now, post, signUp } = harness(transaction, "2026-11-18T09:00:00.000Z");
    const owner = await signUp();
    const workspace = await (await post("/actions/create_workspace", { name: "Team", slug: `use-${crypto.randomUUID()}` }, owner.cookie)).json() as { id: string };
    await transaction.update(workspaces).set({ allowAutopilot: true }).where(eq(workspaces.id, workspace.id));
    const token = await createApiTokenActions(transaction).createApiToken.handler({ userId: owner.id }, { name: "daemon" });
    const registered = await createRuntimeActions(transaction, now).registerDaemon.handler({ userId: owner.id, apiTokenId: token.id }, { hostname: "devbox", version: "1", agentClis: ["claude"] });
    const runtime = registered.runtimes[0]!;
    await createRuntimeActions(transaction, now).shareRuntime.handler({ userId: owner.id }, { runtimeId: runtime.id });
    const coder = await createAgentActions(transaction).createAgent.handler({ userId: owner.id }, { workspaceId: workspace.id, name: "Coder", model: "default", runtimeId: runtime.id });
    await createAgentActions(transaction).setAgentProjectAccess.handler({ userId: owner.id }, { agentId: coder.id, allProjects: true, projectIds: [] });
    await createAgentActions(transaction).setAgentAccess.handler({ userId: owner.id }, { agentId: coder.id, userIds: [owner.id] });
    const project = await createProjectActions(transaction).createProject.handler({ userId: owner.id }, { workspaceId: workspace.id, name: "Alpha", key: "ALP", visibility: "public" });
    for (const title of ["First task", "Second task"]) await createWorkItemActions(transaction).createWorkItem.handler({ userId: owner.id }, { projectId: project.id, title, assigneeIds: [coder.userId] });
    clock.at += 200_000;
    const [listed] = await listRuntimes(app, owner.cookie, workspace.id);
    expect(listed).toMatchObject({ id: runtime.id, online: false, agents: [{ id: coder.id, name: "Coder" }], waitingRuns: 2 });
    // The Runs stay queued until the Daemon claims them: a Runtime that is back online still has two waiting Runs.
    await createRuntimeActions(transaction, now).heartbeat({ userId: owner.id }, registered.daemonId);
    const [back] = await listRuntimes(app, owner.cookie, workspace.id);
    expect(back).toMatchObject({ online: true, offlineSeconds: null, waitingRuns: 2 });
  });
});

test.concurrent("the Runtime list shows the Session folders its Runs used, newest first, with work item and last-used time", async () => {
  await withRollback(db, async (transaction) => {
    const { app, clock, now, post, signUp } = harness(transaction, "2026-11-18T09:00:00.000Z");
    const owner = await signUp();
    const workspace = await (await post("/actions/create_workspace", { name: "Team", slug: `use-${crypto.randomUUID()}` }, owner.cookie)).json() as { id: string };
    await transaction.update(workspaces).set({ allowAutopilot: true }).where(eq(workspaces.id, workspace.id));
    const token = await createApiTokenActions(transaction).createApiToken.handler({ userId: owner.id }, { name: "daemon" });
    const registered = await createRuntimeActions(transaction, now).registerDaemon.handler({ userId: owner.id, apiTokenId: token.id }, { hostname: "devbox", version: "1", agentClis: ["claude"] });
    const runtime = registered.runtimes[0]!;
    await createRuntimeActions(transaction, now).shareRuntime.handler({ userId: owner.id }, { runtimeId: runtime.id });
    const coder = await createAgentActions(transaction).createAgent.handler({ userId: owner.id }, { workspaceId: workspace.id, name: "Coder", model: "default", runtimeId: runtime.id });
    await createAgentActions(transaction).setAgentProjectAccess.handler({ userId: owner.id }, { agentId: coder.id, allProjects: true, projectIds: [] });
    await createAgentActions(transaction).setAgentAccess.handler({ userId: owner.id }, { agentId: coder.id, userIds: [owner.id] });
    const project = await createProjectActions(transaction).createProject.handler({ userId: owner.id }, { workspaceId: workspace.id, name: "Alpha", key: "ALP", visibility: "public" });
    const dispatch = createRuntimeDispatchActions(transaction, now);
    const createItem = (title: string) => createWorkItemActions(transaction).createWorkItem.handler({ userId: owner.id }, { projectId: project.id, title, assigneeIds: [coder.userId] });
    // Each Run is claimed when its work item is queued, so the last-used time is the dispatch time: 09:00:10 and 09:00:20.
    const first = await createItem("Export button");
    clock.at += 10_000;
    const [claimedFirst] = await dispatch.claimRuns({ userId: owner.id, daemonId: registered.daemonId }, 20);
    clock.at += 10_000;
    const second = await createItem("Import button");
    const [claimedSecond] = await dispatch.claimRuns({ userId: owner.id, daemonId: registered.daemonId }, 20);
    const [listed] = await listRuntimes(app, owner.cookie, workspace.id);
    expect(listed!.sessionFolders).toEqual([
      { folder: claimedSecond!.session!.folder, workItem: { id: second.id, title: "Import button", displayId: "ALP-2" }, lastUsedAt: "2026-11-18T09:00:20.000Z" },
      { folder: claimedFirst!.session!.folder, workItem: { id: first.id, title: "Export button", displayId: "ALP-1" }, lastUsedAt: "2026-11-18T09:00:10.000Z" },
    ]);
    // The list is bounded: the newest 10 folders only.
    await transaction.update(agents).set({ maxConcurrentRuns: 50 }).where(eq(agents.id, coder.id));
    for (let index = 3; index <= 12; index += 1) {
      clock.at += 1_000;
      await createItem(`Task ${index}`);
      await dispatch.claimRuns({ userId: owner.id, daemonId: registered.daemonId }, 20);
    }
    const [bounded] = await listRuntimes(app, owner.cookie, workspace.id);
    expect(bounded!.sessionFolders).toHaveLength(10);
    expect(bounded!.sessionFolders[0]!.workItem.title).toBe("Task 12");
    expect(bounded!.sessionFolders.map((folder) => folder.workItem.title)).not.toContain("Export button");
  });
});

test.concurrent("a member sees a shared Runtime's Session folders only for work items in projects they can read", async () => {
  await withRollback(db, async (transaction) => {
    const { app, clock, now, post, signUp } = harness(transaction, "2026-11-18T09:00:00.000Z");
    const owner = await signUp();
    const member = await signUp();
    const workspace = await (await post("/actions/create_workspace", { name: "Team", slug: `use-${crypto.randomUUID()}` }, owner.cookie)).json() as { id: string };
    await transaction.insert(workspaceMembers).values({ workspaceId: workspace.id, userId: member.id, role: "Member" });
    await transaction.update(workspaces).set({ allowAutopilot: true }).where(eq(workspaces.id, workspace.id));
    const token = await createApiTokenActions(transaction).createApiToken.handler({ userId: owner.id }, { name: "daemon" });
    const registered = await createRuntimeActions(transaction, now).registerDaemon.handler({ userId: owner.id, apiTokenId: token.id }, { hostname: "devbox", version: "1", agentClis: ["claude"] });
    const runtime = registered.runtimes[0]!;
    await createRuntimeActions(transaction, now).shareRuntime.handler({ userId: owner.id }, { runtimeId: runtime.id });
    const coder = await createAgentActions(transaction).createAgent.handler({ userId: owner.id }, { workspaceId: workspace.id, name: "Coder", model: "default", runtimeId: runtime.id });
    await createAgentActions(transaction).setAgentProjectAccess.handler({ userId: owner.id }, { agentId: coder.id, allProjects: true, projectIds: [] });
    await createAgentActions(transaction).setAgentAccess.handler({ userId: owner.id }, { agentId: coder.id, userIds: [owner.id] });
    const secret = await createProjectActions(transaction).createProject.handler({ userId: owner.id }, { workspaceId: workspace.id, name: "Secret", key: "SEC", visibility: "private" });
    await createWorkItemActions(transaction).createWorkItem.handler({ userId: owner.id }, { projectId: secret.id, title: "Salary plan", assigneeIds: [coder.userId] });
    clock.at += 10_000;
    await createRuntimeDispatchActions(transaction, now).claimRuns({ userId: owner.id, daemonId: registered.daemonId }, 20);
    const [asOwner] = await listRuntimes(app, owner.cookie, workspace.id);
    expect(asOwner!.sessionFolders.map((folder) => folder.workItem.title)).toEqual(["Salary plan"]);
    const [asMember] = await listRuntimes(app, member.cookie, workspace.id);
    expect(asMember).toMatchObject({ id: runtime.id, sessionFolders: [] });
  });
});
