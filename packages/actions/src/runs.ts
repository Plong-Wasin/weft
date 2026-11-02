import { Type } from "@sinclair/typebox";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "@weft/db";
import { agents, confirmations, projectMembers, runMessages, runs, users, workItems } from "@weft/db";
import { toDisplaySteps } from "./run-steps";
import { agentMonthlyUsage } from "./agent-budget";
import { enqueueJob } from "./jobs";
import { enqueueNotification } from "./notifications";
import { ActionError, requireWorkspaceRole } from "./members";
import { requireProjectAccess } from "./projects";

type RunRow = typeof runs.$inferSelect;
type Context = { userId: string };

/** An Agent runs at most this many Runs at once; further Runs wait in the queue (spec "Limits"). */
export const maxConcurrentRunsPerAgent = 2;

/** A system failure (worker crash, provider network error) is retried automatically this many times; after that the user reruns by hand. */
export const maxAutomaticRetries = 2;

/** Grace after a Run's own time limit before a Run still marked `running` counts as abandoned by a crashed worker. */
const crashGraceMs = 30_000;

const runOutput = Type.Object({
  id: Type.String(), workItemId: Type.String(), projectId: Type.String(), agentId: Type.Union([Type.String(), Type.Null()]), originatorId: Type.String(), status: Type.String(), rerunOfId: Type.Union([Type.String(), Type.Null()]), attempt: Type.Integer(),
  inputTokens: Type.Integer(), outputTokens: Type.Integer(), createdAt: Type.String(), startedAt: Type.Union([Type.String(), Type.Null()]), finishedAt: Type.Union([Type.String(), Type.Null()]),
});

function present(row: RunRow) {
  return {
    id: row.id, workItemId: row.workItemId, projectId: row.projectId, agentId: row.agentId, originatorId: row.originatorId, status: row.status, rerunOfId: row.rerunOfId, attempt: row.attempt,
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

/**
 * Puts a Run that waits on a Confirmation back in the queue and offers it to a worker, once the Confirmation has been decided (or has lapsed).
 * Nothing happens unless the Run is still `waiting_confirmation`, so a late or repeated decision wakes it once. The job re-checks the concurrency limit like any new Run.
 */
export async function wakeRun(database: Database, runId: string, confirmationId: string) {
  const woken = await database.update(runs).set({ status: "queued" }).where(and(eq(runs.id, runId), eq(runs.status, "waiting_confirmation"))).returning({ id: runs.id });
  if (woken.length > 0) await enqueueJob(database, { type: "agent_run", payload: { runId }, dedupeKey: `agent_run:${runId}:${confirmationId}` });
}

/** Withdraws the Confirmations a Run still waits on: they are rejected, so they can no longer be approved and wake nothing. */
async function withdrawConfirmations(database: Database, runId: string) {
  await database.update(confirmations).set({ status: "rejected", result: { withdrawn: true, reason: "run_cancelled" }, resolvedAt: new Date() })
    .where(and(eq(confirmations.runId, runId), eq(confirmations.status, "pending")));
}

/** Completes a cancel the worker has noticed: a `stopping` Run becomes `cancelled`. Returns whether the Run is no longer running, so the loop should stop. */
export async function settleCancelled(database: Database, runId: string): Promise<boolean> {
  const [run] = await database.select({ status: runs.status }).from(runs).where(eq(runs.id, runId));
  if (run?.status === "running") return false;
  if (run?.status === "stopping") {
    await database.update(runs).set({ status: "cancelled", finishedAt: new Date() }).where(and(eq(runs.id, runId), eq(runs.status, "stopping")));
    await withdrawConfirmations(database, runId);
  }
  return true;
}

/** Queues a new Run that repeats `run`: same Agent, work item, Originator and request, linked back to it. Nothing happens when the work item already has an active Run. */
export async function queueRepeatRun(database: Database, run: RunRow, attempt: number): Promise<string | null> {
  const [created] = await database.insert(runs).values({
    workspaceId: run.workspaceId, projectId: run.projectId, workItemId: run.workItemId, agentId: run.agentId, originatorId: run.originatorId, commentId: run.commentId, rerunOfId: run.id, attempt,
  }).onConflictDoNothing().returning({ id: runs.id });
  if (!created) return null;
  await enqueueJob(database, { type: "agent_run", payload: { runId: created.id }, dedupeKey: `agent_run:${created.id}` });
  return created.id;
}

/** Retries a Run that failed for a system reason, unless it already used its automatic retries. Call after the Run left the active statuses. */
export async function retryAutomatically(database: Database, run: RunRow) {
  if (run.attempt >= maxAutomaticRetries) return;
  await queueRepeatRun(database, run, run.attempt + 1);
}

/**
 * Handles an `agent_run` job offered for a Run that is already `running`: the job queue gives a job back only after its worker stopped holding it, so the worker crashed.
 * Once the Run's own time limit has passed, it becomes `stale` and is retried automatically; before that the check is offered again later, since a slow live worker may still own it.
 * A Run whose cancel was pending becomes `cancelled` instead.
 */
export async function recoverAbandonedRun(database: Database, runId: string, now: Date = new Date()) {
  const [run] = await database.select().from(runs).where(eq(runs.id, runId));
  if (!run) return;
  if (run.status === "stopping") { await settleCancelled(database, runId); return; }
  if (run.status !== "running") return;
  const [agent] = run.agentId ? await database.select({ timeoutSeconds: agents.timeoutSeconds }).from(agents).where(eq(agents.id, run.agentId)) : [];
  const abandonedAt = new Date((run.startedAt ?? run.createdAt).getTime() + (agent?.timeoutSeconds ?? 600) * 1000 + crashGraceMs);
  if (abandonedAt.getTime() > now.getTime()) {
    await enqueueJob(database, { type: "agent_run", payload: { runId }, runAt: abandonedAt, dedupeKey: `agent_run:${runId}:recover` });
    return;
  }
  const [stale] = await database.update(runs).set({ status: "stale", failureReason: "worker_crashed", finishedAt: now }).where(and(eq(runs.id, runId), eq(runs.status, "running"))).returning();
  if (stale) await retryAutomatically(database, stale);
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

  /** Loads a Run for a change by its Originator or an admin of its workspace. */
  async function loadControlledRun(database: Database, userId: string, runId: string) {
    const [run] = await database.select().from(runs).where(eq(runs.id, runId)).for("update");
    if (!run) throw new ActionError("Run not found", 404);
    await requireWorkspaceRole(database, userId, run.workspaceId, "read");
    if (run.originatorId !== userId) await requireWorkspaceRole(database, userId, run.workspaceId, "admin");
    return run;
  }

  return {
    cancelRun: {
      name: "cancel_run", kind: "write" as const,
      input: Type.Object({ runId: Type.String({ format: "uuid" }) }), output: runOutput,
      handler: async (context: Context, input: { runId: string }) => db.transaction(async (transaction) => {
        const tx = transaction as unknown as Database;
        const run = await loadControlledRun(tx, context.userId, input.runId);
        if (run.status === "stopping") return present(run);
        if (!["queued", "running", "waiting_confirmation", "awaiting_input"].includes(run.status)) throw new ActionError("This Run is not active", 409);
        // A running Run is told to stop; its worker finishes the cancel at the next step boundary.
        const status = run.status === "running" ? "stopping" : "cancelled";
        const [updated] = await tx.update(runs).set(status === "cancelled" ? { status, finishedAt: new Date() } : { status }).where(eq(runs.id, run.id)).returning();
        if (status === "cancelled") await withdrawConfirmations(tx, run.id);
        return present(updated!);
      }),
    },
    rerunRun: {
      name: "rerun_run", kind: "write" as const,
      input: Type.Object({ runId: Type.String({ format: "uuid" }) }), output: runOutput,
      handler: async (context: Context, input: { runId: string }) => db.transaction(async (transaction) => {
        const tx = transaction as unknown as Database;
        const run = await loadControlledRun(tx, context.userId, input.runId);
        if (!["failed", "cancelled", "stale"].includes(run.status)) throw new ActionError("Only a failed, cancelled or stale Run can be rerun", 409);
        const [agent] = run.agentId ? await tx.select({ enabled: agents.enabled }).from(agents).where(eq(agents.id, run.agentId)) : [];
        if (!agent?.enabled) throw new ActionError("The Agent is not available", 409);
        await requireProjectAccess(tx, run.originatorId, run.projectId, "write");
        const id = await queueRepeatRun(tx, run, 0);
        if (!id) throw new ActionError("This work item already has an active Run", 409);
        const [created] = await tx.select().from(runs).where(eq(runs.id, id));
        return present(created!);
      }),
    },
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
    getRunTranscript: {
      name: "get_run_transcript", kind: "read" as const,
      input: Type.Object({ runId: Type.String({ format: "uuid" }) }),
      output: Type.Object({
        steps: Type.Array(Type.Any()),
        confirmations: Type.Array(Type.Object({ id: Type.String(), toolCallId: Type.Union([Type.String(), Type.Null()]), action: Type.String(), input: Type.Any(), status: Type.String(), expiresAt: Type.String() })),
      }),
      handler: async (context: Context, input: { runId: string }) => {
        const [run] = await db.select().from(runs).where(eq(runs.id, input.runId));
        if (!run) throw new ActionError("Run not found", 404);
        await requireRunReader(context.userId, run.projectId);
        const rows = await db.select().from(runMessages).where(eq(runMessages.runId, run.id)).orderBy(asc(runMessages.seq));
        // A Confirmation is addressed to the Originator: other readers see the steps but never the proposal to decide.
        const cards = run.originatorId === context.userId ? await db.select().from(confirmations).where(and(eq(confirmations.runId, run.id), eq(confirmations.userId, context.userId))).orderBy(asc(confirmations.createdAt)) : [];
        return {
          steps: toDisplaySteps(rows),
          confirmations: cards.map((card) => ({ id: card.id, toolCallId: card.toolCallId, action: card.action, input: card.input, status: card.status === "pending" && card.expiresAt.getTime() <= Date.now() ? "expired" : card.status, expiresAt: card.expiresAt.toISOString() })),
        };
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
