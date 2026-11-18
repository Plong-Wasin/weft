import { afterAll, expect, spyOn, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { activities, agents, createDatabase, runs, runtimes, workspaces, type Database } from "@weft/db";
import { createAgentActions, createApiTokenActions, createJobHandlers, createProjectActions, createRuntimeActions, createWorkItemActions, purgeStaleRuntimes } from "@weft/actions";
import { withRollback } from "../../../packages/db/src/test-helpers";
import { createApp } from "../src/app";

const { client, db } = createDatabase();
afterAll(async () => client.end());

const day = 24 * 60 * 60 * 1000;
const minute = 60_000;
/** The clock of every test: the Runtimes are last seen relative to it, and the hourly cleanup runs eight days later. */
const base = new Date("2026-11-18T09:00:00.000Z");
const eightDaysAhead = new Date(base.getTime() + 8 * day);

function harness(transaction: Database) {
  const app = createApp(undefined, transaction);
  const post = (path: string, body: unknown, cookie?: string) => app.handle(new Request(`http://localhost${path}`, {
    method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body),
  }));
  const signUp = async () => {
    const response = await post("/api/auth/sign-up/email", { name: "Dev", email: `${crypto.randomUUID()}@example.test`, password: "a-secure-password" });
    const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
    const me = await (await app.handle(new Request("http://localhost/api/me", { headers: { cookie } }))).json() as { user: { id: string } };
    return { cookie, id: me.user.id };
  };
  return { app, post, signUp };
}

/** An owner with a workspace (Autopilot on) and a Daemon that registered a claude and a codex Runtime. */
async function setUp(transaction: Database, post: ReturnType<typeof harness>["post"], signUp: ReturnType<typeof harness>["signUp"]) {
  const owner = await signUp();
  const workspace = await (await post("/actions/create_workspace", { name: "Team", slug: `stale-${crypto.randomUUID()}` }, owner.cookie)).json() as { id: string };
  await transaction.update(workspaces).set({ allowAutopilot: true }).where(eq(workspaces.id, workspace.id));
  const token = await createApiTokenActions(transaction).createApiToken.handler({ userId: owner.id }, { name: "daemon" });
  const registered = await createRuntimeActions(transaction).registerDaemon.handler({ userId: owner.id, apiTokenId: token.id }, { hostname: "devbox", version: "1", agentClis: ["claude", "codex"] });
  const claude = registered.runtimes.find((runtime) => runtime.agentCli === "claude")!;
  const codex = registered.runtimes.find((runtime) => runtime.agentCli === "codex")!;
  // Shared with the workspace, so Agents can be bound to them.
  for (const runtime of [claude, codex]) await createRuntimeActions(transaction).shareRuntime.handler({ userId: owner.id }, { runtimeId: runtime.id });
  return { owner, workspace, daemonId: registered.daemonId, claude, codex };
}

/** Sets when the Runtime was last seen, the time the cleanup measures its offline time from. */
async function seenAt(transaction: Database, runtimeId: string, at: Date, stopped = false) {
  await transaction.update(runtimes).set({ lastSeenAt: at, stopped }).where(eq(runtimes.id, runtimeId));
}

async function present(transaction: Database, runtimeId: string) {
  return (await transaction.select({ id: runtimes.id }).from(runtimes).where(eq(runtimes.id, runtimeId))).length === 1;
}

/** Runs the hourly cleanup job the way the worker does, with the clock the test sets. */
async function hourlyCleanup(transaction: Database, now: Date) {
  await createJobHandlers(undefined, { now: () => now }).cleanup_stale_runtimes!(transaction, {}, { id: "hourly", type: "cleanup_stale_runtimes" });
}

async function bindCoder(transaction: Database, owner: { id: string }, workspaceId: string, runtimeId: string) {
  const coder = await createAgentActions(transaction).createAgent.handler({ userId: owner.id }, { workspaceId, name: "Coder", model: "default", runtimeId });
  await createAgentActions(transaction).setAgentProjectAccess.handler({ userId: owner.id }, { agentId: coder.id, allProjects: true, projectIds: [] });
  await createAgentActions(transaction).setAgentAccess.handler({ userId: owner.id }, { agentId: coder.id, userIds: [owner.id] });
  return coder;
}

test.concurrent("the hourly cleanup removes a Runtime last seen eight days before its clock and keeps one seen six days before", async () => {
  await withRollback(db, async (transaction) => {
    const { post, signUp } = harness(transaction);
    const { claude, codex } = await setUp(transaction, post, signUp);
    await seenAt(transaction, claude.id, base);
    await seenAt(transaction, codex.id, new Date(base.getTime() + 2 * day));
    await hourlyCleanup(transaction, eightDaysAhead);
    expect(await present(transaction, claude.id)).toBe(false);
    expect(await present(transaction, codex.id)).toBe(true);
  });
});

test.concurrent("an enabled bound Agent keeps its offline Runtime past seven days", async () => {
  await withRollback(db, async (transaction) => {
    const { post, signUp } = harness(transaction);
    const { owner, workspace, claude } = await setUp(transaction, post, signUp);
    await bindCoder(transaction, owner, workspace.id, claude.id);
    await seenAt(transaction, claude.id, base);
    await hourlyCleanup(transaction, eightDaysAhead);
    expect(await present(transaction, claude.id)).toBe(true);
  });
});

test.concurrent("an unfinished Run keeps its offline Runtime past seven days, even when its Agent is disabled", async () => {
  await withRollback(db, async (transaction) => {
    const { post, signUp } = harness(transaction);
    const { owner, workspace, claude } = await setUp(transaction, post, signUp);
    const coder = await bindCoder(transaction, owner, workspace.id, claude.id);
    const project = await createProjectActions(transaction).createProject.handler({ userId: owner.id }, { workspaceId: workspace.id, name: "Alpha", key: "ALP", visibility: "public" });
    await createWorkItemActions(transaction).createWorkItem.handler({ userId: owner.id }, { projectId: project.id, title: "Waiting task", assigneeIds: [coder.userId] });
    // A raw update leaves the queued Run in place, the case under test (disabling through the action would cancel it).
    await transaction.update(agents).set({ enabled: false }).where(eq(agents.id, coder.id));
    await seenAt(transaction, claude.id, base);
    await hourlyCleanup(transaction, eightDaysAhead);
    expect(await present(transaction, claude.id)).toBe(true);
  });
});

test.concurrent("a disabled bound Agent does not keep an offline Runtime: its binding goes and the removal is audited with no actor", async () => {
  await withRollback(db, async (transaction) => {
    const { post, signUp } = harness(transaction);
    const { owner, workspace, claude } = await setUp(transaction, post, signUp);
    const coder = await bindCoder(transaction, owner, workspace.id, claude.id);
    await createAgentActions(transaction).disableAgent.handler({ userId: owner.id }, { agentId: coder.id });
    await seenAt(transaction, claude.id, base);
    await hourlyCleanup(transaction, eightDaysAhead);
    expect(await present(transaction, claude.id)).toBe(false);
    const [agent] = await transaction.select({ runtimeId: agents.runtimeId, enabled: agents.enabled }).from(agents).where(eq(agents.id, coder.id));
    expect(agent).toEqual({ runtimeId: null, enabled: false });
  });
});

test.concurrent("a Runtime whose Daemon stopped one minute before the clock, or whose offline time is unknown, is never removed", async () => {
  await withRollback(db, async (transaction) => {
    const { post, signUp } = harness(transaction);
    const { claude, codex } = await setUp(transaction, post, signUp);
    await seenAt(transaction, claude.id, new Date(eightDaysAhead.getTime() - minute), true);
    await seenAt(transaction, codex.id, new Date(0));
    await hourlyCleanup(transaction, eightDaysAhead);
    expect(await present(transaction, claude.id)).toBe(true);
    expect(await present(transaction, codex.id)).toBe(true);
  });
});

test.concurrent("a candidate that gained an enabled Agent before its locked re-check is skipped and counted, and kept", async () => {
  await withRollback(db, async (transaction) => {
    const { post, signUp } = harness(transaction);
    const { owner, workspace, claude, codex } = await setUp(transaction, post, signUp);
    const coder = await bindCoder(transaction, owner, workspace.id, codex.id);
    await seenAt(transaction, claude.id, base);
    await seenAt(transaction, codex.id, new Date(base.getTime() + 2 * day));
    const round = await purgeStaleRuntimes(transaction, eightDaysAhead, {
      // The Agent is bound to the stale Runtime after it was picked and before its row lock: the re-check must see it.
      beforeRecheck: async (runtimeId) => { if (runtimeId === claude.id) await transaction.update(agents).set({ runtimeId }).where(eq(agents.id, coder.id)); },
    });
    expect(round).toEqual({ deleted: 0, skipped: 1, failed: 0 });
    expect(await present(transaction, claude.id)).toBe(true);
  });
});

test.concurrent("a candidate that gained an unfinished Run before its locked re-check is skipped and counted, and kept", async () => {
  await withRollback(db, async (transaction) => {
    const { post, signUp } = harness(transaction);
    const { owner, workspace, claude, codex } = await setUp(transaction, post, signUp);
    const coder = await bindCoder(transaction, owner, workspace.id, codex.id);
    const project = await createProjectActions(transaction).createProject.handler({ userId: owner.id }, { workspaceId: workspace.id, name: "Alpha", key: "ALP", visibility: "public" });
    await createWorkItemActions(transaction).createWorkItem.handler({ userId: owner.id }, { projectId: project.id, title: "Waiting task", assigneeIds: [coder.userId] });
    await seenAt(transaction, claude.id, base);
    await seenAt(transaction, codex.id, new Date(base.getTime() + 2 * day));
    const round = await purgeStaleRuntimes(transaction, eightDaysAhead, {
      // A queued Run is claimed by the stale Runtime after it was picked and before its row lock: the re-check must see it.
      beforeRecheck: async (runtimeId) => { if (runtimeId === claude.id) await transaction.update(runs).set({ runtimeId }).where(eq(runs.status, "queued")); },
    });
    expect(round).toEqual({ deleted: 0, skipped: 1, failed: 0 });
    expect(await present(transaction, claude.id)).toBe(true);
  });
});

test.concurrent("one failing candidate is logged and the round goes on to the next", async () => {
  await withRollback(db, async (transaction) => {
    const { post, signUp } = harness(transaction);
    const { claude, codex } = await setUp(transaction, post, signUp);
    await seenAt(transaction, claude.id, base);
    await seenAt(transaction, codex.id, base);
    const log = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const round = await purgeStaleRuntimes(transaction, eightDaysAhead, {
        beforeRecheck: async (runtimeId) => { if (runtimeId === claude.id) throw new Error("disk on fire"); },
      });
      expect(round).toEqual({ deleted: 1, skipped: 0, failed: 1 });
      expect(log.mock.calls.some((call) => String(call[0]).includes(claude.id) && String(call[0]).includes("disk on fire"))).toBe(true);
    } finally {
      log.mockRestore();
    }
    expect(await present(transaction, claude.id)).toBe(true);
    expect(await present(transaction, codex.id)).toBe(false);
  });
});

test.concurrent("a round takes the oldest stale Runtimes first up to its limit, and takes none once its time budget is spent", async () => {
  await withRollback(db, async (transaction) => {
    const { post, signUp } = harness(transaction);
    const { claude, codex } = await setUp(transaction, post, signUp);
    await seenAt(transaction, claude.id, new Date(base.getTime() - 9 * day));
    await seenAt(transaction, codex.id, new Date(base.getTime() - 8 * day));
    expect(await purgeStaleRuntimes(transaction, base, { budgetMs: 0 })).toEqual({ deleted: 0, skipped: 0, failed: 0 });
    expect(await present(transaction, claude.id) && await present(transaction, codex.id)).toBe(true);
    expect(await purgeStaleRuntimes(transaction, base, { limit: 1 })).toEqual({ deleted: 1, skipped: 0, failed: 0 });
    expect(await present(transaction, claude.id)).toBe(false);
    expect(await present(transaction, codex.id)).toBe(true);
  });
});

test.concurrent("a removal is audited with the system as actor, and the Daemon is told on its next heartbeat", async () => {
  await withRollback(db, async (transaction) => {
    const { post, signUp } = harness(transaction);
    const { owner, daemonId, claude, codex } = await setUp(transaction, post, signUp);
    await seenAt(transaction, claude.id, base);
    await seenAt(transaction, codex.id, new Date(base.getTime() + 2 * day));
    await hourlyCleanup(transaction, eightDaysAhead);
    const [entry] = await transaction.select().from(activities).where(and(eq(activities.entityType, "runtime"), eq(activities.entityId, claude.id), eq(activities.field, "deleted")));
    expect(entry).toMatchObject({ actorId: null, source: "system", newValue: null, oldValue: { ownerId: owner.id, agentCli: "claude", hostname: "devbox" } });
    const acknowledged = await createRuntimeActions(transaction).heartbeat({ userId: owner.id }, daemonId, [claude.id, codex.id]);
    expect(acknowledged).toEqual({ goneRuntimeIds: [claude.id] });
  });
});

test.concurrent("a Runtime kept by an enabled Agent does not use up a round's limit and starve a newer Runtime that is free to remove", async () => {
  await withRollback(db, async (transaction) => {
    const { post, signUp } = harness(transaction);
    const { owner, workspace, claude, codex } = await setUp(transaction, post, signUp);
    await bindCoder(transaction, owner, workspace.id, claude.id);
    await seenAt(transaction, claude.id, new Date(base.getTime() - 9 * day));
    await seenAt(transaction, codex.id, new Date(base.getTime() - 8 * day));
    expect(await purgeStaleRuntimes(transaction, base, { limit: 1 })).toEqual({ deleted: 1, skipped: 0, failed: 0 });
    expect(await present(transaction, claude.id)).toBe(true);
    expect(await present(transaction, codex.id)).toBe(false);
  });
});
