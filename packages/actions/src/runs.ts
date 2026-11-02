import { Type } from "@sinclair/typebox";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "@weft/db";
import { agents, projectMembers, runs, users, workItems } from "@weft/db";
import { agentMonthlyUsage } from "./agent-budget";
import { enqueueJob } from "./jobs";
import { enqueueNotification } from "./notifications";
import { ActionError } from "./members";
import { requireProjectAccess } from "./projects";

type RunRow = typeof runs.$inferSelect;
type Context = { userId: string };

/** An Agent runs at most this many Runs at once; further Runs wait in the queue (spec "Limits"). */
export const maxConcurrentRunsPerAgent = 2;

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
 * Queues a Run for every enabled Agent among `assigneeUserIds` (new assignees, or the people a comment mentions), naming `originatorId` as the Originator.
 * A mention passes the `commentId` that is the Run's request. An Agent not opened to the project gets no Run.
 * Nothing is queued when the Originator cannot write in the project, and the unique index on active Runs means a work item holds at most one.
 * Call it inside the transaction that saved the assignment so the Run and its job commit together.
 */
export async function queueRunsForAssignees(database: Database, input: { originatorId: string; project: { id: string; workspaceId: string }; workItemId: string; assigneeUserIds: string[]; commentId?: string }) {
  if (input.assigneeUserIds.length === 0) return;
  const targets = await database.select({ id: agents.id, userId: agents.userId, budget: agents.monthlyTokenBudget }).from(agents)
    .innerJoin(projectMembers, and(eq(projectMembers.userId, agents.userId), eq(projectMembers.projectId, input.project.id)))
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
    if (target.budget !== null && (await agentMonthlyUsage(database, target.id)) >= target.budget) {
      const [skipped] = await database.insert(runs).values({
        workspaceId: input.project.workspaceId, projectId: input.project.id, workItemId: input.workItemId, agentId: target.id, originatorId: input.originatorId, commentId: input.commentId ?? null,
        status: "skipped", failureReason: "budget_exceeded", finishedAt: new Date(),
      }).returning({ id: runs.id });
      if (skipped) await enqueueNotification(database, { kind: "run_skipped", workItemId: input.workItemId, commentId: input.commentId, actorId: target.userId, recipientIds: [input.originatorId] });
      continue;
    }
    const [created] = await database.insert(runs).values({
      workspaceId: input.project.workspaceId, projectId: input.project.id, workItemId: input.workItemId, agentId: target.id, originatorId: input.originatorId, commentId: input.commentId ?? null,
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
    const [agent] = await tx.select({ id: agents.id, userId: agents.userId, enabled: agents.enabled, budget: agents.monthlyTokenBudget }).from(agents).where(eq(agents.id, run.agentId)).for("update");
    if (!agent?.enabled) return "gone";
    const [current] = await tx.select({ id: runs.id }).from(runs).where(eq(runs.id, runId)).for("update");
    if (!current) return "gone";
    // A Run that waited in the queue while the budget ran out never starts.
    if (agent.budget !== null && (await agentMonthlyUsage(tx, agent.id)) >= agent.budget) {
      await tx.update(runs).set({ status: "skipped", failureReason: "budget_exceeded", finishedAt: new Date() }).where(eq(runs.id, runId));
      await enqueueNotification(tx, { kind: "run_skipped", workItemId: run.workItemId, commentId: run.commentId ?? undefined, actorId: agent.userId, recipientIds: [run.originatorId] });
      return "gone";
    }
    const [{ count }] = await tx.select({ count: sql<number>`count(*)::int` }).from(runs).where(and(eq(runs.agentId, agent.id), inArray(runs.status, ["running", "stopping"])));
    if (count! >= maxConcurrentRunsPerAgent) return "waiting";
    const updated = await tx.update(runs).set({ status: "running", startedAt: new Date() }).where(and(eq(runs.id, runId), eq(runs.status, "queued"))).returning({ id: runs.id });
    return updated.length > 0 ? "started" : "gone";
  });
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
