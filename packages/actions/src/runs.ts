import { Type } from "@sinclair/typebox";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "@weft/db";
import { agents, runs, users, workItems } from "@weft/db";
import { enqueueJob } from "./jobs";
import { ActionError } from "./members";
import { requireProjectAccess } from "./projects";

type RunRow = typeof runs.$inferSelect;
type Context = { userId: string };

/** An Agent runs at most this many Runs at once; further Runs wait in the queue (spec "Limits"). */
export const maxConcurrentRunsPerAgent = 2;
/** How long a Run that found its Agent at the limit waits before the queue offers it again. */
const deferralMs = 5_000;

const runOutput = Type.Object({
  id: Type.String(), workItemId: Type.String(), projectId: Type.String(), agentId: Type.Union([Type.String(), Type.Null()]), originatorId: Type.String(), status: Type.String(),
  inputTokens: Type.Integer(), outputTokens: Type.Integer(), createdAt: Type.String(), startedAt: Type.Union([Type.String(), Type.Null()]), finishedAt: Type.Union([Type.String(), Type.Null()]),
});

function present(row: RunRow) {
  return {
    id: row.id, workItemId: row.workItemId, projectId: row.projectId, agentId: row.agentId, originatorId: row.originatorId, status: row.status,
    inputTokens: row.inputTokens, outputTokens: row.outputTokens, createdAt: row.createdAt.toISOString(), startedAt: row.startedAt?.toISOString() ?? null, finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

/**
 * Queues a Run for every enabled Agent among the new assignees, naming `originatorId` as the Originator.
 * Nothing is queued when the Originator cannot write in the project, and the unique index on active Runs means a work item holds at most one.
 * Call it inside the transaction that saved the assignment so the Run and its job commit together.
 */
export async function queueRunsForAssignees(database: Database, input: { originatorId: string; project: { id: string; workspaceId: string }; workItemId: string; assigneeUserIds: string[] }) {
  if (input.assigneeUserIds.length === 0) return;
  const targets = await database.select({ id: agents.id }).from(agents)
    .where(and(inArray(agents.userId, input.assigneeUserIds), eq(agents.enabled, true), eq(agents.workspaceId, input.project.workspaceId)))
    .orderBy(asc(agents.createdAt), asc(agents.id));
  if (targets.length === 0) return;
  // A bot never starts a Run, and a person without write access in the project may not use an Agent to act there.
  const [originator] = await database.select({ isAgent: users.isAgent }).from(users).where(eq(users.id, input.originatorId));
  if (originator?.isAgent) return;
  try {
    await requireProjectAccess(database, input.originatorId, input.project.id, "write");
  } catch (error) {
    if (error instanceof ActionError) return;
    throw error;
  }
  for (const target of targets) {
    const [created] = await database.insert(runs).values({
      workspaceId: input.project.workspaceId, projectId: input.project.id, workItemId: input.workItemId, agentId: target.id, originatorId: input.originatorId,
    }).onConflictDoNothing().returning({ id: runs.id });
    if (created) await enqueueJob(database, { type: "agent_run", payload: { runId: created.id }, dedupeKey: `agent_run:${created.id}` });
  }
}

/** Cancels every queued Run of an Agent. Runs already running are left to finish or be cancelled by their Originator. */
export async function cancelQueuedRuns(database: Database, agentId: string) {
  await database.update(runs).set({ status: "cancelled", finishedAt: new Date() }).where(and(eq(runs.agentId, agentId), eq(runs.status, "queued")));
}

/**
 * Moves a queued Run to `running`, unless its Agent already runs the maximum number of Runs.
 * "waiting" means the Run stays queued and must be offered again later; "gone" means it is no longer queued (cancelled, started or deleted).
 */
export async function startRun(database: Database, runId: string): Promise<"started" | "waiting" | "gone"> {
  return database.transaction(async (transaction) => {
    const tx = transaction as unknown as Database;
    const [run] = await tx.select().from(runs).where(eq(runs.id, runId));
    if (!run || run.status !== "queued" || !run.agentId) return "gone";
    // The Agent row is the lock: two workers starting Runs of one Agent take turns, so the count below cannot be raced past the limit.
    const [agent] = await tx.select({ id: agents.id, enabled: agents.enabled }).from(agents).where(eq(agents.id, run.agentId)).for("update");
    if (!agent?.enabled) return "gone";
    const [current] = await tx.select({ id: runs.id }).from(runs).where(eq(runs.id, runId)).for("update");
    if (!current) return "gone";
    const [{ count }] = await tx.select({ count: sql<number>`count(*)::int` }).from(runs).where(and(eq(runs.agentId, agent.id), inArray(runs.status, ["running", "stopping"])));
    if (count! >= maxConcurrentRunsPerAgent) return "waiting";
    const updated = await tx.update(runs).set({ status: "running", startedAt: new Date() }).where(and(eq(runs.id, runId), eq(runs.status, "queued"))).returning({ id: runs.id });
    return updated.length > 0 ? "started" : "gone";
  });
}

/** The `agent_run` job: claims the Run, or puts it back in the queue when its Agent is at the limit. Executing a started Run is added on top of this. */
export async function handleAgentRunJob(database: Database, payload: { runId: string }) {
  const outcome = await startRun(database, payload.runId);
  if (outcome === "waiting") await enqueueJob(database, { type: "agent_run", payload: { runId: payload.runId }, runAt: new Date(Date.now() + deferralMs) });
}

/** Run Actions: members list a work item's Runs and read one. Guests are refused, as they are for Agent work they were not part of (spec story 32). */
export function createRunActions(db: Database) {
  async function requireRunReader(userId: string, projectId: string) {
    const access = await requireProjectAccess(db, userId, projectId, "read");
    if (access.workspaceRole === "Guest") throw new ActionError("Forbidden", 403);
  }

  return {
    listRuns: {
      name: "list_runs", kind: "read" as const,
      input: Type.Object({ workItemId: Type.String({ format: "uuid" }) }), output: Type.Array(runOutput),
      handler: async (context: Context, input: { workItemId: string }) => {
        const [item] = await db.select({ projectId: workItems.projectId }).from(workItems).where(eq(workItems.id, input.workItemId));
        if (!item) throw new ActionError("Work item not found", 404);
        await requireRunReader(context.userId, item.projectId);
        return (await db.select().from(runs).where(eq(runs.workItemId, input.workItemId)).orderBy(desc(runs.createdAt), desc(runs.id))).map(present);
      },
    },
    getRun: {
      name: "get_run", kind: "read" as const,
      input: Type.Object({ runId: Type.String({ format: "uuid" }) }), output: runOutput,
      handler: async (context: Context, input: { runId: string }) => {
        const [run] = await db.select().from(runs).where(eq(runs.id, input.runId));
        if (!run) throw new ActionError("Run not found", 404);
        await requireRunReader(context.userId, run.projectId);
        return present(run);
      },
    },
  };
}
