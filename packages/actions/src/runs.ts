import { Type } from "@sinclair/typebox";
import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import type { Database } from "@weft/db";
import { activities, agents, confirmations, projectMembers, runMessages, runs, runtimeProfiles, runtimes, users, workItems, workspaceMembers, workspaces } from "@weft/db";
import { toDisplaySteps } from "./run-steps";
import { agentMonthlyUsage } from "./agent-budget";
import { estimateCostUsd, loadPriceTable, type PriceTable } from "./usage";
import { enqueueJob } from "./jobs";
import { enqueueNotification } from "./notifications";
import { ActionError, requireWorkspaceRole } from "./members";
import { requireProjectAccess } from "./projects";
import { hasAgentAccess } from "./agent-access";

type RunRow = typeof runs.$inferSelect;
type Context = { userId: string };

/** An Agent runs at most this many Runs at once; further Runs wait in the queue (spec "Limits"). */
export const maxConcurrentRunsPerAgent = 2;

/** Rejects a new Run when its Originator or Agent has reached the workspace's rolling hourly cap. */
export async function enforceHourlyRunLimits(database: Database, input: { workspaceId: string; originatorId: string; agentId: string }, now = new Date()) {
  const [limits] = await database.select({ person: workspaces.runtimeRunsPerPersonPerHour, agent: workspaces.runtimeRunsPerAgentPerHour }).from(workspaces).where(eq(workspaces.id, input.workspaceId));
  if (!limits) return;
  // Serialize all Run creation for one Originator in a workspace before checking either rolling count.
  await database.execute(sql`select pg_advisory_xact_lock(hashtext(${input.workspaceId}), hashtext(${input.originatorId}))`);
  const since = new Date(now.getTime() - 60 * 60_000);
  const [{ count: personCount }] = await database.select({ count: sql<number>`count(*)::int` }).from(runs).where(and(eq(runs.workspaceId, input.workspaceId), eq(runs.originatorId, input.originatorId), sql`${runs.createdAt} >= ${since.toISOString()}::timestamptz`));
  if (personCount >= limits.person) throw new ActionError(`Run limit reached: ${limits.person} Runs per person per hour. Try again later.`, 429);
  const [{ count: agentCount }] = await database.select({ count: sql<number>`count(*)::int` }).from(runs).where(and(eq(runs.workspaceId, input.workspaceId), eq(runs.agentId, input.agentId), sql`${runs.createdAt} >= ${since.toISOString()}::timestamptz`));
  if (agentCount >= limits.agent) throw new ActionError(`Run limit reached: ${limits.agent} Runs per Agent per hour. Try again later.`, 429);
}

/** A system failure (worker crash, provider network error) is retried automatically this many times; after that the user reruns by hand. */
export const maxAutomaticRetries = 2;

export class AgentAccessDeniedError extends ActionError {
  constructor(message: string, readonly workItemId: string, readonly agentName: string) { super(message, 403); }
}

/** Grace after a Run's own time limit before a Run still marked `running` counts as abandoned by a crashed worker. */
const crashGraceMs = 30_000;

const runOutput = Type.Object({
  id: Type.String(), workItemId: Type.Union([Type.String(), Type.Null()]), projectId: Type.String(), agentId: Type.Union([Type.String(), Type.Null()]), originatorId: Type.String(), status: Type.String(), rerunOfId: Type.Union([Type.String(), Type.Null()]), attempt: Type.Integer(),
  inputTokens: Type.Integer(), outputTokens: Type.Integer(), cacheReadTokens: Type.Integer(), cacheCreationTokens: Type.Integer(), usageReported: Type.Boolean(), model: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String(), startedAt: Type.Union([Type.String(), Type.Null()]), finishedAt: Type.Union([Type.String(), Type.Null()]), failureMessage: Type.Union([Type.String(), Type.Null()]), failureReason: Type.Union([Type.String(), Type.Null()]),
  /** Wall-clock time from start to finish; null until both are known. */
  elapsedMs: Type.Union([Type.Integer(), Type.Null()]),
  /** Estimated USD from the workspace price table; null means unknown (no reported usage, no model, or no price). */
  estimatedCostUsd: Type.Union([Type.Number(), Type.Null()]),
  /** True when `estimatedCostUsd` is the total the provider's CLI reported, not an estimate from the price table. */
  costReported: Type.Boolean(),
});

/** The daemon's own words about a failed start are shown only to a workspace Admin and the owner of the Run's Runtime; everyone else gets the failureReason code to translate. */
const detailReasons = ["sandbox_unavailable", "spawn_failed"];

/** Whether the viewer may read the raw failure detail of a Run: a workspace Admin, or the owner of the Runtime the Run's Agent uses. */
async function failureDetailAllowed(database: Database, userId: string, workspaceRole: string | null | undefined, rows: RunRow[]): Promise<(row: RunRow) => boolean> {
  if (workspaceRole === "Admin") return () => true;
  const agentIds = [...new Set(rows.flatMap((row) => row.agentId && detailReasons.includes(row.failureReason ?? "") ? [row.agentId] : []))];
  if (agentIds.length === 0) return () => false;
  const owned = new Set((await database.select({ id: agents.id }).from(agents).innerJoin(runtimes, eq(runtimes.id, agents.runtimeId)).where(and(inArray(agents.id, agentIds), eq(runtimes.ownerId, userId)))).map((row) => row.id));
  return (row) => row.agentId !== null && owned.has(row.agentId);
}

/** Shown to the person who asked for the Run, in the Run page, when the Agent's monthly token budget stopped it. */
export const budgetExceededMessage = "The Agent's monthly token budget is used up, so this Run did not start. An Admin can raise the budget in Settings.";

/** Presents Runs with their usage, elapsed time and estimated cost. The price table is read once per call, so every Run of one workspace is priced the same way. `mayReadDetail` says whose raw failure detail is shown. */
async function presentRuns(database: Database, rows: RunRow[], mayReadDetail: (row: RunRow) => boolean = () => false) {
  const prices = new Map<string, PriceTable>();
  for (const row of rows) if (!prices.has(row.workspaceId)) prices.set(row.workspaceId, await loadPriceTable(database, row.workspaceId));
  return rows.map((row) => {
    const usage = {
      usageReported: row.usageReported, inputTokens: row.inputTokens, outputTokens: row.outputTokens, model: row.model,
      cacheReadTokens: row.cacheReadTokens, cacheCreationTokens: row.cacheCreationTokens, reportedCostUsd: row.reportedCostUsd === null ? null : Number(row.reportedCostUsd),
    };
    return {
      id: row.id, workItemId: row.workItemId, projectId: row.projectId, agentId: row.agentId, originatorId: row.originatorId, status: row.status, rerunOfId: row.rerunOfId, attempt: row.attempt,
      inputTokens: row.inputTokens, outputTokens: row.outputTokens, cacheReadTokens: row.cacheReadTokens, cacheCreationTokens: row.cacheCreationTokens, usageReported: row.usageReported, model: row.model,
      createdAt: row.createdAt.toISOString(), startedAt: row.startedAt?.toISOString() ?? null, finishedAt: row.finishedAt?.toISOString() ?? null,
      failureMessage: row.failureReason === "budget_exceeded" ? budgetExceededMessage : mayReadDetail(row) && detailReasons.includes(row.failureReason ?? "") ? row.finalOutput : null,
      failureReason: row.failureReason,
      elapsedMs: row.startedAt && row.finishedAt ? row.finishedAt.getTime() - row.startedAt.getTime() : null,
      estimatedCostUsd: estimateCostUsd(usage, prices.get(row.workspaceId) ?? new Map()),
      costReported: usage.reportedCostUsd !== null,
    };
  });
}
const presentRun = async (database: Database, row: RunRow) => (await presentRuns(database, [row]))[0]!;

/**
 * Queues a Run for every enabled Agent among `assigneeUserIds` (new assignees, or the people a comment mentions), naming `originatorId` as the Originator.
 * A mention passes the `commentId` that is the Run's request. An Agent not opened to the project gets no Run.
 * Nothing is queued when the Originator cannot write in the project, and the unique index on active Runs means a work item holds at most one.
 * Call it inside the transaction that saved the assignment so the Run and its job commit together.
 */
export async function queueRunsForAssignees(database: Database, input: { originatorId: string; project: { id: string; workspaceId: string }; workItemId: string; assigneeUserIds: string[]; commentId?: string }) {
  if (input.assigneeUserIds.length === 0) return;
  const targets = await database.select({ id: agents.id, userId: agents.userId, name: users.name, budget: agents.monthlyTokenBudget, runtimeId: agents.runtimeId }).from(agents)
    .innerJoin(users, eq(users.id, agents.userId))
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
    if (!(await hasAgentAccess(database, target.id, input.originatorId))) {
      throw new AgentAccessDeniedError(`You do not have Agent access to ${target.name}. Ask its owner or an Admin to grant access.`, input.workItemId, target.name);
    }
    const [existing] = await database.select({ id: runs.id }).from(runs).where(and(eq(runs.workspaceId, input.project.workspaceId), eq(runs.workItemId, input.workItemId), eq(runs.agentId, target.id), inArray(runs.status, ["queued", "dispatched", "running", "stopping", "waiting_confirmation", "awaiting_input"])));
    if (existing) continue;
    await enforceHourlyRunLimits(database, { workspaceId: input.project.workspaceId, originatorId: input.originatorId, agentId: target.id });
    // Runtime Runs count against the budget too: their tokens arrive from the Daemon when they finish.
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
  // One transaction, so a Run is never left `queued` without the job that starts it.
  await database.transaction(async (transaction) => {
    const tx = transaction as unknown as Database;
    const woken = await tx.update(runs).set({ status: "queued" }).where(and(eq(runs.id, runId), eq(runs.status, "waiting_confirmation"))).returning({ id: runs.id });
    if (woken.length > 0) await enqueueJob(tx, { type: "agent_run", payload: { runId }, dedupeKey: `agent_run:${runId}:${confirmationId}` });
  });
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
  // A repeat acts for the Originator, so it needs the same Agent access a first Run needs; revoked access ends reruns and retries too.
  const [originator] = await database.select({ isAgent: users.isAgent }).from(users).where(eq(users.id, run.originatorId));
  if (!originator?.isAgent && !(await hasAgentAccess(database, run.agentId!, run.originatorId))) throw new ActionError("The person who started this Run no longer has Agent access", 403);
  await enforceHourlyRunLimits(database, { workspaceId: run.workspaceId, originatorId: run.originatorId, agentId: run.agentId! });
  const [created] = await database.insert(runs).values({
    workspaceId: run.workspaceId, projectId: run.projectId, workItemId: run.workItemId, agentId: run.agentId, originatorId: run.originatorId, commentId: run.commentId, triggerId: run.triggerId, rerunOfId: run.id, attempt,
  }).onConflictDoNothing().returning({ id: runs.id });
  if (!created) return null;
  await enqueueJob(database, { type: "agent_run", payload: { runId: created.id }, dedupeKey: `agent_run:${created.id}` });
  return created.id;
}

/** Retries a Run that failed for a system reason, unless it already used its automatic retries. Call after the Run left the active statuses. */
export async function retryAutomatically(database: Database, run: RunRow) {
  if (run.attempt >= maxAutomaticRetries) return;
  try { await queueRepeatRun(database, run, run.attempt + 1); }
  catch (error) { if (!(error instanceof ActionError) || (error.status !== 429 && error.status !== 403)) throw error; }
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

/** Revokes every active Run, leaving running Runtime work in stopping until its Daemon acknowledges cancellation. */
export async function revokeAgentRuns(database: Database, agentId: string, actorId: string, reason: string, originatorId?: string) {
  const active = await database.select().from(runs).where(and(eq(runs.agentId, agentId), ...(originatorId ? [eq(runs.originatorId, originatorId)] : []), inArray(runs.status, ["queued", "dispatched", "running", "stopping", "waiting_confirmation", "awaiting_input"])));
  const now = new Date();
  for (const run of active) {
    const running = ["dispatched", "running", "stopping"].includes(run.status);
    await database.update(runs).set({ status: running ? "stopping" : "failed", failureReason: reason, ...(running ? {} : { finishedAt: now }) })
      .where(and(eq(runs.id, run.id), inArray(runs.status, ["queued", "dispatched", "running", "stopping", "waiting_confirmation", "awaiting_input"])));
    if (!running) await withdrawConfirmations(database, run.id);
    if (run.workItemId) await database.insert(activities).values({
      workspaceId: run.workspaceId, projectId: run.projectId, entityType: "work_item", entityId: run.workItemId,
      field: "run_revoked", oldValue: { status: run.status }, newValue: { status: running ? "stopping" : "failed", reason }, actorId, source: "ui",
    });
  }
}

/**
 * Suspending a member stops their work in one workspace: Runs they started and Runs on Runtimes they own.
 * Queued Runs are cancelled; Runtime work is asked to stop and settles when its Daemon acknowledges.
 */
export async function revokeMemberRuns(database: Database, workspaceId: string, userId: string, actorId: string, reason: string) {
  const ownedRuntimes = database.select({ id: runtimes.id }).from(runtimes).where(and(eq(runtimes.workspaceId, workspaceId), eq(runtimes.ownerId, userId)));
  const active = await database.select().from(runs).where(and(
    eq(runs.workspaceId, workspaceId), inArray(runs.status, ["queued", "dispatched", "running", "stopping", "waiting_confirmation", "awaiting_input"]),
    or(eq(runs.originatorId, userId), inArray(runs.runtimeId, ownedRuntimes)),
  ));
  const now = new Date();
  for (const run of active) {
    const running = ["dispatched", "running", "stopping"].includes(run.status);
    await database.update(runs).set({ status: running ? "stopping" : "cancelled", failureReason: reason, ...(running ? {} : { finishedAt: now }) })
      .where(and(eq(runs.id, run.id), inArray(runs.status, ["queued", "dispatched", "running", "stopping", "waiting_confirmation", "awaiting_input"])));
    if (!running) await withdrawConfirmations(database, run.id);
    if (run.workItemId) await database.insert(activities).values({
      workspaceId: run.workspaceId, projectId: run.projectId, entityType: "work_item", entityId: run.workItemId,
      field: "run_revoked", oldValue: { status: run.status }, newValue: { status: running ? "stopping" : "cancelled", reason }, actorId, source: "ui",
    });
  }
  return active.length;
}

/** Disabling or deleting an Agent cancels queued Runs, while active Runtime work is asked to stop. */
export async function cancelAgentRuns(database: Database, agentId: string, actorId: string, reason: string) {
  const active = await database.select().from(runs).where(and(eq(runs.agentId, agentId), inArray(runs.status, ["queued", "dispatched", "running", "stopping", "waiting_confirmation", "awaiting_input"])));
  const now = new Date();
  for (const run of active) {
    const running = ["dispatched", "running", "stopping"].includes(run.status);
    await database.update(runs).set({ status: running ? "stopping" : "cancelled", failureReason: reason, ...(running ? {} : { finishedAt: now }) })
      .where(and(eq(runs.id, run.id), inArray(runs.status, ["queued", "dispatched", "running", "stopping", "waiting_confirmation", "awaiting_input"])));
    if (!running) await withdrawConfirmations(database, run.id);
    if (run.workItemId) await database.insert(activities).values({
      workspaceId: run.workspaceId, projectId: run.projectId, entityType: "work_item", entityId: run.workItemId,
      field: "run_revoked", oldValue: { status: run.status }, newValue: { status: running ? "stopping" : "cancelled", reason }, actorId, source: "ui",
    });
  }
}

/**
 * Moves a queued Run to `running`, unless its Agent already runs the maximum number of Runs.
 * `modelId` is the model the worker really calls (`AI_MODEL`); it is recorded so the price table can match it. The Agent's own model label is only the fallback.
 * "waiting" means the Run stays queued and must be offered again later; "gone" means it is no longer queued (cancelled, started or deleted).
 */
export async function startRun(database: Database, runId: string, modelId?: string | null): Promise<"started" | "waiting" | "gone"> {
  return database.transaction(async (transaction) => {
    const tx = transaction as unknown as Database;
    const [run] = await tx.select().from(runs).where(eq(runs.id, runId));
    if (!run || run.status !== "queued" || !run.agentId) return "gone";
    // The Agent row is the lock: two workers starting Runs of one Agent take turns, so the count below cannot be raced past the limit.
    const [agent] = await tx.select({ id: agents.id, userId: agents.userId, enabled: agents.enabled, budget: agents.monthlyTokenBudget, runtimeId: agents.runtimeId, maxConcurrentRuns: agents.maxConcurrentRuns, model: agents.model }).from(agents).where(eq(agents.id, run.agentId)).for("update");
    // A Run woken after its Agent was disabled (it waited on a Confirmation) never starts: it ends cancelled, not stuck queued.
    if (agent && !agent.enabled) {
      await tx.update(runs).set({ status: "cancelled", finishedAt: new Date() }).where(eq(runs.id, runId));
      return "gone";
    }
    if (!agent) return "gone";
    // Runtime-bound Runs remain queued for daemon dispatch (ticket 05); the server worker never starts them.
    if (agent.runtimeId) return "gone";
    const [current] = await tx.select({ id: runs.id }).from(runs).where(eq(runs.id, runId)).for("update");
    if (!current) return "gone";
    // A Run that waited in the queue while the budget ran out never starts.
    if (agent.budget !== null && (await agentMonthlyUsage(tx, agent.id)) >= agent.budget) {
      await tx.update(runs).set({ status: "skipped", failureReason: "budget_exceeded", finishedAt: new Date() }).where(eq(runs.id, runId));
      if (run.workItemId) await enqueueNotification(tx, { kind: "run_skipped", workItemId: run.workItemId, commentId: run.commentId ?? undefined, actorId: agent.userId, recipientIds: [run.originatorId] });
      return "gone";
    }
    const [{ count }] = await tx.select({ count: sql<number>`count(*)::int` }).from(runs).where(and(eq(runs.agentId, agent.id), inArray(runs.status, ["running", "stopping"])));
    if (count! >= maxConcurrentRunsPerAgent) return "waiting";
    const updated = await tx.update(runs).set({ status: "running", startedAt: new Date(), model: modelId ?? agent.model }).where(and(eq(runs.id, runId), eq(runs.status, "queued"))).returning({ id: runs.id });
    return updated.length > 0 ? "started" : "gone";
  });
}

/** Run Actions: members list a work item's Runs and read one. Guests are refused, as they are for Agent work they were not part of (spec story 32). */
export function createRunActions(db: Database) {
  async function requireRunReader(userId: string, projectId: string) {
    const access = await requireProjectAccess(db, userId, projectId, "read");
    if (access.workspaceRole === "Guest") throw new ActionError("Forbidden", 403);
    return access;
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
        if (run.status === "stopping") return presentRun(tx, run);
        if (!["queued", "dispatched", "running", "waiting_confirmation", "awaiting_input"].includes(run.status)) throw new ActionError("This Run is not active", 409);
        // A running Run is told to stop; its worker finishes the cancel at the next step boundary.
        const status = run.status === "running" ? "stopping" : "cancelled";
        const [updated] = await tx.update(runs).set(status === "cancelled" ? { status, finishedAt: new Date() } : { status }).where(eq(runs.id, run.id)).returning();
        if (status === "cancelled") await withdrawConfirmations(tx, run.id);
        return presentRun(tx, updated!);
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
        return presentRun(tx, created!);
      }),
    },
    listRuns: {
      name: "list_runs", kind: "read" as const,
      input: Type.Object({ workItemId: Type.String({ format: "uuid" }) }), output: Type.Array(runOutput),
      handler: async (context: Context, input: { workItemId: string }) => {
        const [item] = await db.select({ projectId: workItems.projectId }).from(workItems).where(eq(workItems.id, input.workItemId));
        if (!item) throw new ActionError("Work item not found", 404);
        const access = await requireRunReader(context.userId, item.projectId);
        const rows = await db.select().from(runs).where(eq(runs.workItemId, input.workItemId)).orderBy(desc(runs.createdAt), desc(runs.id));
        return presentRuns(db, rows, await failureDetailAllowed(db, context.userId, access.workspaceRole, rows));
      },
    },
    listAgentRuns: {
      name: "list_agent_runs", kind: "read" as const, input: Type.Object({ agentId: Type.String({ format: "uuid" }) }), output: Type.Array(runOutput),
      handler: async (context: Context, input: { agentId: string }) => {
        const [agent] = await db.select().from(agents).where(eq(agents.id, input.agentId));
        if (!agent) throw new ActionError("Agent not found", 404);
        await requireWorkspaceRole(db, context.userId, agent.workspaceId, "read");
        if (await db.select({ id: agents.id }).from(agents).where(and(eq(agents.id, agent.id), eq(agents.userId, context.userId))).then((rows) => rows.length) === 0) await requireWorkspaceRole(db, context.userId, agent.workspaceId, "admin");
        const rows = await db.select().from(runs).where(eq(runs.agentId, agent.id)).orderBy(desc(runs.createdAt), desc(runs.id));
        const [membership] = await db.select({ role: workspaceMembers.role }).from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, agent.workspaceId), eq(workspaceMembers.userId, context.userId)));
        return presentRuns(db, rows, await failureDetailAllowed(db, context.userId, membership?.role, rows));
      },
    },
    getRunTranscript: {
      name: "get_run_transcript", kind: "read" as const,
      input: Type.Object({ runId: Type.String({ format: "uuid" }) }),
      output: Type.Object({
        steps: Type.Array(Type.Any()),
        runtimeProfile: Type.Union([Type.Object({ name: Type.String(), sandbox: Type.String(), enforceSandbox: Type.Boolean() }), Type.Null()]),
        failureMessage: Type.Union([Type.String(), Type.Null()]),
        failureReason: Type.Union([Type.String(), Type.Null()]),
        confirmations: Type.Array(Type.Object({ id: Type.String(), toolCallId: Type.Union([Type.String(), Type.Null()]), action: Type.String(), input: Type.Any(), status: Type.String(), expiresAt: Type.String() })),
      }),
      handler: async (context: Context, input: { runId: string }) => {
        const [run] = await db.select().from(runs).where(eq(runs.id, input.runId));
        if (!run) throw new ActionError("Run not found", 404);
        const [profile] = run.agentId ? await db.select({ name: runtimeProfiles.name, sandbox: runtimeProfiles.sandbox, enforceSandbox: runtimes.enforceSandbox }).from(agents).innerJoin(runtimeProfiles, eq(runtimeProfiles.id, agents.runtimeProfileId)).innerJoin(runtimes, eq(runtimes.id, agents.runtimeId)).where(eq(agents.id, run.agentId)) : [];
        const access = await requireRunReader(context.userId, run.projectId);
        const rows = await db.select().from(runMessages).where(eq(runMessages.runId, run.id)).orderBy(asc(runMessages.seq));
        // Tool inputs and results, and the thoughts that quote them, were read with the Originator's permissions (private projects, wiki), so other members see which tools ran, not what they returned.
        const full = run.originatorId === context.userId || access.workspaceRole === "Admin";
        // A Confirmation is addressed to the Originator: other readers see the steps but never the proposal to decide.
        const cards = run.originatorId === context.userId ? await db.select().from(confirmations).where(and(eq(confirmations.runId, run.id), eq(confirmations.userId, context.userId))).orderBy(asc(confirmations.createdAt)) : [];
        return {
          steps: toDisplaySteps(rows).map((step) => full ? step : step.kind === "tool_call" ? { ...step, input: null, result: null } : step.kind === "thought" ? { ...step, text: "" } : step),
          runtimeProfile: profile ? { name: profile.name, sandbox: profile.sandbox, enforceSandbox: profile.enforceSandbox } : null,
          failureMessage: (await failureDetailAllowed(db, context.userId, access.workspaceRole, [run]))(run) && detailReasons.includes(run.failureReason ?? "") ? run.finalOutput : null,
          failureReason: run.failureReason,
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
        return presentRun(db, run);
      },
    },
  };
}
