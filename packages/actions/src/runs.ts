import { Type } from "@sinclair/typebox";
import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import type { Database } from "@weft/db";
import { activities, agents, comments, confirmations, projectMembers, runMessages, runs, runtimeProfiles, runtimes, users, workItems, workspaceMembers, workspaces } from "@weft/db";
import { steerMessageType, toDisplaySteps, type SteerMessage } from "./run-steps";
import { agentMonthlyUsage } from "./agent-budget";
import { estimateCostUsd, loadPriceTable, type PriceTable } from "./usage";
import { enqueueJob } from "./jobs";
import { enqueueNotification } from "./notifications";
import { ActionError, requireWorkspaceRole } from "./members";
import { requireProjectAccess } from "./projects";
import { hasAgentAccess } from "./agent-access";
import { emitRunFinished } from "./outbound-webhooks";

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
  /** `resumed` or `new` for a Runtime Run that has started; null for server Runs and Runs not yet started. */
  sessionMode: Type.Union([Type.Literal("resumed"), Type.Literal("new"), Type.Null()]),
  /** Why the Session is new or resumed, as a short code; null when there is none. */
  sessionReason: Type.Union([Type.String(), Type.Null()]),
  /** The Run that woke this Run and this Run's depth in the Wake chain; null for a Run a person or schedule started. `runId` is null when the viewer may not open that Run. */
  wokenBy: Type.Union([Type.Object({ runId: Type.Union([Type.String(), Type.Null()]), agentName: Type.String(), depth: Type.Integer() }), Type.Null()]),
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

/** The waking Runs of some Runs: their Agent's name and project, so a Run can say who woke it. */
export async function loadWakingRuns(database: Database, runIds: string[]) {
  const ids = [...new Set(runIds)];
  if (ids.length === 0) return new Map<string, { id: string; projectId: string; agentName: string }>();
  const found = await database.select({ id: runs.id, projectId: runs.projectId, agentName: users.name }).from(runs).innerJoin(agents, eq(agents.id, runs.agentId)).innerJoin(users, eq(users.id, agents.userId)).where(inArray(runs.id, ids));
  return new Map(found.map((row) => [row.id, row]));
}

/** Who woke a Run: the waking Run's Agent and this Run's depth. The waking Run is linked only inside its own project, which the viewer reads with the Run. */
function wokenByOf(row: RunRow, wakers: Map<string, { id: string; projectId: string; agentName: string }>) {
  const waker = row.wokenByRunId ? wakers.get(row.wokenByRunId) : undefined;
  if (!waker) return null;
  return { runId: waker.projectId === row.projectId ? waker.id : null, agentName: waker.agentName, depth: row.depth };
}

/** Presents Runs with their usage, elapsed time and estimated cost. The price table is read once per call, so every Run of one workspace is priced the same way. `mayReadDetail` says whose raw failure detail is shown. */
async function presentRuns(database: Database, rows: RunRow[], mayReadDetail: (row: RunRow) => boolean = () => false) {
  const prices = new Map<string, PriceTable>();
  for (const row of rows) if (!prices.has(row.workspaceId)) prices.set(row.workspaceId, await loadPriceTable(database, row.workspaceId));
  const wakers = await loadWakingRuns(database, rows.flatMap((row) => row.wokenByRunId ? [row.wokenByRunId] : []));
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
      sessionMode: row.sessionMode === "resumed" || row.sessionMode === "new" ? row.sessionMode : null,
      sessionReason: row.sessionReason,
      wokenBy: wokenByOf(row, wakers),
      estimatedCostUsd: estimateCostUsd(usage, prices.get(row.workspaceId) ?? new Map()),
      costReported: usage.reportedCostUsd !== null,
    };
  });
}
const presentRun = async (database: Database, row: RunRow) => (await presentRuns(database, [row]))[0]!;

/** Run statuses that hold an Agent's place on a work item: at most one Run in these statuses per Agent and work item, enforced by a unique index (migration 0110). */
export const activeRunStatuses = ["queued", "dispatched", "running", "stopping", "waiting_confirmation", "awaiting_input"] as const;

/** Status of a Follow-up Run: a request kept while its Agent's active Run on the work item ends. It is not active, so it does not hold the place (ADR 0013). */
export const followUpStatus = "follow_up";

/** Statuses in which a server Run still takes another step, so a steered comment reaches its model (ADR 0013). A stopping Run takes none. */
export const steerableRunStatuses = ["queued", "running", "waiting_confirmation"] as const;

/** Why a wake did not start a Run. A skip never fails the action that asked for the wake (ADR 0013). */
export const wakeSkipReasons = ["switch_off", "no_project_write", "active_run", "over_budget", "depth_limit", "no_agent_access", "hourly_limit"] as const;
export type WakeSkipReason = (typeof wakeSkipReasons)[number];

/** What one target of an assignment or mention got: a started Run, a Follow-up Run it waits in (`waiting`), or a skip with its reason. */
export type WakeOutcome = { agentId: string; userId: string; agentName: string; status: "started" | "waiting" | "steered" | "skipped"; reason: WakeSkipReason | null; runId: string | null };

export const wakeOutcomeOutput = Type.Object({
  agentId: Type.String(), userId: Type.String(), agentName: Type.String(),
  status: Type.Union([Type.Literal("started"), Type.Literal("waiting"), Type.Literal("steered"), Type.Literal("skipped")]),
  reason: Type.Union([...wakeSkipReasons.map((reason) => Type.Literal(reason)), Type.Null()]),
  runId: Type.Union([Type.String(), Type.Null()]),
});

/** Who made the change that may wake an Agent: a person, or an Agent or Autopilot (which wakes one only through its Run's chain, when its Agent has Can wake Agents on). */
export type Waker = "person" | "agent";
export function wakerOf(source?: string): Waker {
  return source === "agent" || source === "agent_autopilot" || source === "ai_autopilot" ? "agent" : "person";
}

/** The chain a Run belongs to: a Run a person or schedule started has no waking Run and depth 0. */
export const personChain = { wokenByRunId: null, depth: 0 } as const;

type WakeTarget = { id: string; userId: string; name: string; budget: number | null; runtimeId: string | null };

function skippedOutcome(target: WakeTarget, reason: WakeSkipReason): WakeOutcome {
  return { agentId: target.id, userId: target.userId, agentName: target.name, status: "skipped", reason, runId: null };
}

/** The Run an Agent has on a work item that holds its place there, as far as a new request needs to know. */
type ActiveRun = { id: string; status: string; originatorId: string; runtimeId: string | null; startedAt: Date | null; createdAt: Date };

async function findActiveRun(database: Database, workspaceId: string, workItemId: string, agentId: string): Promise<ActiveRun | null> {
  const [active] = await database.select({ id: runs.id, status: runs.status, originatorId: runs.originatorId, runtimeId: runs.runtimeId, startedAt: runs.startedAt, createdAt: runs.createdAt }).from(runs)
    .where(and(eq(runs.workspaceId, workspaceId), eq(runs.workItemId, workItemId), eq(runs.agentId, agentId), inArray(runs.status, [...activeRunStatuses])));
  return active ?? null;
}

/**
 * Adds a row at the end of a Run's transcript. The run row is locked first, so writers of one transcript (the Run's own steps and a steered comment) take turns and never pick the same sequence number.
 */
export async function appendRunMessage(database: Database, row: { runId: string; type: string; toolName?: string | null; toolCallId?: string | null; input?: unknown; output?: unknown }) {
  await database.transaction(async (transaction) => {
    const tx = transaction as unknown as Database;
    await tx.select({ id: runs.id }).from(runs).where(eq(runs.id, row.runId)).for("update");
    await tx.insert(runMessages).values({
      runId: row.runId, seq: sql`(select coalesce(max(${runMessages.seq}), 0) + 1 from ${runMessages} where ${runMessages.runId} = ${row.runId})`,
      type: row.type, toolName: row.toolName ?? null, toolCallId: row.toolCallId ?? null, input: row.input ?? null, output: row.output ?? null,
    });
  });
}

/**
 * Steers an active server Run (ADR 0013): the comment joins its transcript as a person's message, and the executor includes it at the next step.
 * The Run's row is locked while it is checked, so the Run cannot finish in between. Returns false when the Run is no longer steerable.
 */
async function steerRun(database: Database, runId: string, commentId: string): Promise<boolean> {
  const [locked] = await database.select({ status: runs.status }).from(runs).where(eq(runs.id, runId)).for("update");
  if (!locked || !(steerableRunStatuses as readonly string[]).includes(locked.status)) return false;
  const [comment] = await database.select({ text: comments.bodyText, author: users.name }).from(comments).innerJoin(users, eq(users.id, comments.authorId)).where(eq(comments.id, commentId));
  if (!comment) return false;
  const steer: SteerMessage = { commentId, author: comment.author, text: comment.text };
  await appendRunMessage(database, { runId, type: steerMessageType, output: steer });
  return true;
}

/**
 * A request for an Agent that already has an active Run on the work item (ADR 0013): it becomes that Agent's one Follow-up Run on the item, and a later request joins it.
 * The Follow-up Run has the depth and waking Run of the request, and starts when the active Run reaches a final status (`startFollowUpRun`).
 * Its Activity says waiting. A new Follow-up Run is subject to the hourly Run limits; joining one is not.
 */
async function requestFollowUp(database: Database, input: {
  target: WakeTarget; workspaceId: string; projectId: string; workItemId: string; originatorId: string;
  commentId?: string | null; triggerId?: string | null; chain: { wokenByRunId: string | null; depth: number };
}, active: ActiveRun | null): Promise<WakeOutcome> {
  const { target, workspaceId, projectId, workItemId, originatorId } = input;
  const existing = async () => (await database.select({ id: runs.id }).from(runs).where(and(eq(runs.agentId, target.id), eq(runs.workItemId, workItemId), eq(runs.status, followUpStatus))))[0]?.id ?? null;
  let runId = await existing();
  if (!runId) {
    await enforceHourlyRunLimits(database, { workspaceId, originatorId, agentId: target.id });
    // The comments written since the active Run began belong to the Follow-up Run's prompt.
    const since = active ? (active.startedAt ?? active.createdAt) : new Date();
    const [created] = await database.insert(runs).values({
      workspaceId, projectId, workItemId, agentId: target.id, originatorId, commentId: input.commentId ?? null, triggerId: input.triggerId ?? null,
      status: followUpStatus, wokenByRunId: input.chain.wokenByRunId, depth: input.chain.depth, followUpSince: since,
    }).onConflictDoNothing().returning({ id: runs.id });
    // Nothing inserted means a request that raced this one committed the Follow-up Run first.
    runId = created?.id ?? (await existing());
  }
  if (!runId) throw new ActionError("The Follow-up Run could not be recorded. Try again.", 409);
  await database.insert(activities).values({
    workspaceId, projectId, entityType: "work_item", entityId: workItemId, field: "run_waiting", oldValue: null,
    newValue: { status: "waiting", agentId: target.id, agentName: target.name, runId }, actorId: originatorId, source: "ui",
  });
  return { agentId: target.id, userId: target.userId, agentName: target.name, status: "waiting", reason: null, runId };
}

/**
 * Starts the Follow-up Run of an Agent on a work item, if the work item holds no active Run of that Agent: it becomes `queued` and its job is enqueued.
 * Call it after any change that may have ended the active Run. Nothing happens while an active Run remains, so calling it too early is harmless, but a retry that queues a Run must come first.
 */
export async function startFollowUpRun(database: Database, agentId: string, workItemId: string): Promise<string | null> {
  const [active] = await database.select({ id: runs.id }).from(runs).where(and(eq(runs.agentId, agentId), eq(runs.workItemId, workItemId), inArray(runs.status, [...activeRunStatuses])));
  if (active) return null;
  const [started] = await database.update(runs).set({ status: "queued" }).where(and(eq(runs.agentId, agentId), eq(runs.workItemId, workItemId), eq(runs.status, followUpStatus)))
    .returning({ id: runs.id, workspaceId: runs.workspaceId, projectId: runs.projectId, originatorId: runs.originatorId, wokenByRunId: runs.wokenByRunId });
  if (!started) return null;
  // The Follow-up Run starts on the timeline as its Agent's Run; an Agent's request keeps the Run that woke it (`wokenByRunId`).
  const [agent] = await database.select({ userId: agents.userId, name: users.name }).from(agents).innerJoin(users, eq(users.id, agents.userId)).where(eq(agents.id, agentId));
  if (agent) await recordRunActivity(database, { workspaceId: started.workspaceId, projectId: started.projectId, workItemId, field: "run_started", newValue: { agentId, agentName: agent.name, runId: started.id }, actorId: agent.userId, originatorId: started.originatorId, source: started.wokenByRunId ? "agent" : "ui" });
  await enqueueJob(database, { type: "agent_run", payload: { runId: started.id }, dedupeKey: `agent_run:${started.id}` });
  return started.id;
}

/** Records one Run event on its work item's timeline: started, waiting, steered or a skipped wake (ADR 0013). */
async function recordRunActivity(database: Database, input: { workspaceId: string; projectId: string; workItemId: string; field: string; newValue: unknown; actorId: string; originatorId: string; source: "ui" | "agent" }) {
  // The Run is named in newValue, not in the Activity's runId: runId marks a change the Run's Agent made (ADR 0013 timeline), which these entries are not.
  await database.insert(activities).values({
    workspaceId: input.workspaceId, projectId: input.projectId, entityType: "work_item", entityId: input.workItemId, field: input.field, oldValue: null,
    newValue: input.newValue, actorId: input.actorId, source: input.source, originatorId: input.originatorId,
  });
}

/** Where a wake's Activity and notice go when it does not happen: the work item, and the Originator of the chain. */
type RefusedWake = { step: WakeStep; target: WakeTarget; workspaceId: string; projectId: string; workItemId: string | null; commentId?: string | null };

/**
 * Records a wake that did not happen for an Agent's change: an Activity on the work item with the reason, a notice to the Originator, and a skipped outcome.
 * The Agent's own action is not failed (ADR 0013). Without a work item there is nothing to record on.
 */
async function refuseWake(database: Database, refused: RefusedWake, reason: WakeSkipReason): Promise<WakeOutcome> {
  const { step, target, workspaceId, projectId, workItemId, commentId } = refused;
  if (workItemId) {
    await database.insert(activities).values({
      workspaceId, projectId, entityType: "work_item", entityId: workItemId, field: "wake_skipped", oldValue: null,
      newValue: { reason, agentId: target.id, agentName: target.name, depth: step.depth + 1 }, actorId: step.agentUserId, source: "agent",
    });
    await enqueueNotification(database, { kind: "wake_skipped", workItemId, commentId: commentId ?? undefined, actorId: step.agentUserId, recipientIds: [step.originatorId], detail: reason });
  }
  return skippedOutcome(target, reason);
}

/** Whether a person may write in the project right now. Access is checked at every wake, so a person removed mid-chain is refused. */
async function canWriteProject(database: Database, userId: string, projectId: string): Promise<boolean> {
  try {
    await requireProjectAccess(database, userId, projectId, "write");
    return true;
  } catch (error) {
    if (error instanceof ActionError) return false;
    throw error;
  }
}

/**
 * The one wake decision (ADR 0013): every path that starts a Run for an Agent calls it, after the caller checked a person's own project write and Agent access.
 * - An Agent's or Autopilot's change (`waker` "agent") wakes only when its Run's Agent has the Can wake Agents switch on (`switch_off` otherwise). Then the chain's Originator, depth and waking Run are taken from that Run, and the wake is refused with an Activity and a notice when the depth would pass `maxWakeDepth` (`depth_limit`), when the Originator may not write in the project (`no_project_write`) or may not use the target Agent (`no_agent_access`). A hourly Run limit that holds the wake is `hourly_limit`.
 * - An Agent with an active Run on the work item gets a Follow-up Run, which starts when that Run ends (`waiting`); the unique index refuses a second active Run even when two requests race.
 * - An Agent over its monthly token budget gets a skipped Run record and the Originator is notified (`over_budget`).
 * - Otherwise the Run is queued, with the chain it belongs to, and its job is enqueued in the same transaction.
 * Call it inside the transaction that saved the change so the Run and its job commit together.
 */
export async function decideAndStartWake(database: Database, input: {
  waker: Waker; step?: WakeStep | null; target: WakeTarget; workspaceId: string; projectId: string; workItemId: string | null; originatorId: string;
  commentId?: string | null; triggerId?: string | null; chain?: { wokenByRunId: string | null; depth: number };
}): Promise<WakeOutcome> {
  const { target, workspaceId, projectId, workItemId, commentId, triggerId } = input;
  // A person's request starts a chain of its own unless it names the chain it belongs to (a Follow-up Run's request does).
  if (input.waker !== "agent") return startWake(database, { waker: input.waker, actorId: input.originatorId, target, workspaceId, projectId, workItemId, originatorId: input.originatorId, commentId, triggerId, chain: input.chain ?? personChain });
  const step = input.step;
  if (!step?.canWakeAgents) return step ? refuseWake(database, { step, target, workspaceId, projectId, workItemId, commentId }, "switch_off") : skippedOutcome(target, "switch_off");
  const refused: RefusedWake = { step, target, workspaceId, projectId, workItemId, commentId };
  const chain = { wokenByRunId: step.runId, depth: step.depth + 1 };
  if (chain.depth > maxWakeDepth) return refuseWake(database, refused, "depth_limit");
  if (!(await canWriteProject(database, step.originatorId, projectId))) return refuseWake(database, refused, "no_project_write");
  if (!(await hasAgentAccess(database, target.id, step.originatorId))) return refuseWake(database, refused, "no_agent_access");
  try {
    return await startWake(database, { waker: "agent", actorId: step.agentUserId, target, workspaceId, projectId, workItemId, originatorId: step.originatorId, commentId, triggerId, chain });
  } catch (error) {
    if (error instanceof ActionError && error.status === 429) return refuseWake(database, refused, "hourly_limit");
    throw error;
  }
}

/** The source of a timeline entry: an Agent's or Autopilot's change is shown as made by the Agent, a person's as the UI. */
function sourceOf(waker: Waker): "ui" | "agent" {
  return waker === "agent" ? "agent" : "ui";
}

/** The part of the wake decision that starts, waits or skips for an Agent whose wake is allowed to go on. The Originator and chain are already settled. */
async function startWake(database: Database, input: {
  waker: Waker; actorId: string; target: WakeTarget; workspaceId: string; projectId: string; workItemId: string | null; originatorId: string;
  commentId?: string | null; triggerId?: string | null; chain: { wokenByRunId: string | null; depth: number };
}): Promise<WakeOutcome> {
  const { target, workspaceId, projectId, workItemId, originatorId } = input;
  if (workItemId) {
    const active = await findActiveRun(database, workspaceId, workItemId, target.id);
    if (active) {
      // A person's mention steers a server Run of the same Originator (its Agent acts for that person only); a Runtime Run cannot be steered (ADR 0013).
      const steerable = input.waker === "person" && !!input.commentId && target.runtimeId === null && active.runtimeId === null && active.originatorId === originatorId;
      if (steerable && (await steerRun(database, active.id, input.commentId!))) {
        await recordRunActivity(database, { workspaceId, projectId, workItemId, field: "run_steered", newValue: { agentId: target.id, agentName: target.name, runId: active.id }, actorId: input.actorId, originatorId, source: sourceOf(input.waker) });
        return { agentId: target.id, userId: target.userId, agentName: target.name, status: "steered", reason: null, runId: active.id };
      }
      return requestFollowUp(database, { ...input, target, workspaceId, projectId, workItemId, originatorId }, active);
    }
  }
  await enforceHourlyRunLimits(database, { workspaceId, originatorId, agentId: target.id });
  // Runtime Runs count against the budget too: their tokens arrive from the Daemon when they finish.
  if (target.budget !== null && (await agentMonthlyUsage(database, target.id)) >= target.budget) {
    await database.insert(runs).values({
      workspaceId, projectId, workItemId, agentId: target.id, originatorId, commentId: input.commentId ?? null, triggerId: input.triggerId ?? null,
      status: "skipped", failureReason: "budget_exceeded", finishedAt: new Date(),
    });
    if (workItemId) {
      await recordRunActivity(database, { workspaceId, projectId, workItemId, field: "wake_skipped", newValue: { reason: "over_budget", agentId: target.id, agentName: target.name, depth: input.chain.depth }, actorId: input.actorId, originatorId, source: sourceOf(input.waker) });
      await enqueueNotification(database, { kind: "run_skipped", workItemId, commentId: input.commentId ?? undefined, actorId: target.userId, recipientIds: [originatorId] });
    }
    return skippedOutcome(target, "over_budget");
  }
  const [created] = await database.insert(runs).values({
    workspaceId, projectId, workItemId, agentId: target.id, originatorId, commentId: input.commentId ?? null, triggerId: input.triggerId ?? null,
    wokenByRunId: input.chain.wokenByRunId, depth: input.chain.depth,
  }).onConflictDoNothing().returning({ id: runs.id });
  // Nothing inserted means a request that raced this one committed its active Run first: this request waits in the Follow-up Run.
  if (!created) return requestFollowUp(database, { ...input, target, workspaceId, projectId, workItemId: workItemId!, originatorId }, workItemId ? await findActiveRun(database, workspaceId, workItemId, target.id) : null);
  if (workItemId) await recordRunActivity(database, { workspaceId, projectId, workItemId, field: "run_started", newValue: { agentId: target.id, agentName: target.name, runId: created.id }, actorId: input.waker === "agent" ? target.userId : originatorId, originatorId, source: sourceOf(input.waker) });
  await enqueueJob(database, { type: "agent_run", payload: { runId: created.id }, dedupeKey: `agent_run:${created.id}` });
  return { agentId: target.id, userId: target.userId, agentName: target.name, status: "started", reason: null, runId: created.id };
}

/**
 * Wakes every enabled Agent among `assigneeUserIds` (new assignees, or the people a comment mentions), naming `originatorId` as the Originator, and reports one Wake outcome per Agent.
 * A mention passes the `commentId` that is the Run's request. An Agent not opened to the project is not a target and gets no outcome.
 * A person's change: a person without write access in the project gets `no_project_write` for each Agent; a person whose Originator lacks Agent access to an Agent gets the existing refusal.
 * An Agent's or Autopilot's change (`waker` "agent") is decided per Agent by `decideAndStartWake`, using the chain of the Run in `wakingRunId`; `originatorId` is then not used.
 * Call it inside the transaction that saved the assignment or comment.
 */
export async function queueRunsForAssignees(database: Database, input: { originatorId: string; waker?: Waker; wakingRunId?: string | null; project: { id: string; workspaceId: string }; workItemId: string; assigneeUserIds: string[]; commentId?: string }): Promise<WakeOutcome[]> {
  if (input.assigneeUserIds.length === 0) return [];
  const targets = await database.select({ id: agents.id, userId: agents.userId, name: users.name, budget: agents.monthlyTokenBudget, runtimeId: agents.runtimeId }).from(agents)
    .innerJoin(users, eq(users.id, agents.userId))
    .innerJoin(projectMembers, and(eq(projectMembers.userId, agents.userId), eq(projectMembers.projectId, input.project.id)))
    .where(and(inArray(agents.userId, input.assigneeUserIds), eq(agents.enabled, true), eq(agents.workspaceId, input.project.workspaceId)))
    .orderBy(asc(agents.createdAt), asc(agents.id));
  if (targets.length === 0) return [];
  // A bot never starts a Run through a person's change; a person without write access in the project may not use an Agent to act there.
  const [originator] = await database.select({ isAgent: users.isAgent }).from(users).where(eq(users.id, input.originatorId));
  const waker: Waker = input.waker === "agent" || originator?.isAgent ? "agent" : "person";
  if (waker === "agent") {
    const step = await loadWakeStep(database, input.wakingRunId);
    const outcomes: WakeOutcome[] = [];
    for (const target of targets) outcomes.push(await decideAndStartWake(database, { waker, step, target, workspaceId: input.project.workspaceId, projectId: input.project.id, workItemId: input.workItemId, originatorId: input.originatorId, commentId: input.commentId ?? null }));
    return outcomes;
  }
  let writable = false;
  try {
    await requireProjectAccess(database, input.originatorId, input.project.id, "write");
    writable = true;
  } catch (error) {
    if (!(error instanceof ActionError)) throw error;
  }
  const outcomes: WakeOutcome[] = [];
  for (const target of targets) {
    if (!writable) { outcomes.push(skippedOutcome(target, "no_project_write")); continue; }
    if (!(await hasAgentAccess(database, target.id, input.originatorId))) {
      throw new AgentAccessDeniedError(`You do not have Agent access to ${target.name}. Ask its owner or an Admin to grant access.`, input.workItemId, target.name);
    }
    outcomes.push(await decideAndStartWake(database, {
      waker, target, workspaceId: input.project.workspaceId, projectId: input.project.id, workItemId: input.workItemId, originatorId: input.originatorId,
      commentId: input.commentId ?? null,
    }));
  }
  return outcomes;
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
  return database.transaction(async (transaction) => {
    const tx = transaction as unknown as Database;
    const [run] = await tx.select({ status: runs.status }).from(runs).where(eq(runs.id, runId));
    if (run?.status === "running") return false;
    if (run?.status === "stopping") {
      const [settled] = await tx.update(runs).set({ status: "cancelled", finishedAt: new Date() }).where(and(eq(runs.id, runId), eq(runs.status, "stopping"))).returning({ id: runs.id, agentId: runs.agentId, workItemId: runs.workItemId });
      if (settled) {
        await withdrawConfirmations(tx, runId);
        await emitRunFinished(tx, runId);
        if (settled.agentId && settled.workItemId) await startFollowUpRun(tx, settled.agentId, settled.workItemId);
      }
    }
    return true;
  });
}

/** Queues a new Run that repeats `run`: same Agent, work item, Originator and request, linked back to it. Nothing happens when the work item already has an active Run. */
export async function queueRepeatRun(database: Database, run: RunRow, attempt: number, options: { freshSession?: boolean } = {}): Promise<string | null> {
  // A repeat acts for the Originator, so it needs the same Agent access a first Run needs; revoked access ends reruns and retries too.
  const [originator] = await database.select({ isAgent: users.isAgent }).from(users).where(eq(users.id, run.originatorId));
  if (!originator?.isAgent && !(await hasAgentAccess(database, run.agentId!, run.originatorId))) throw new ActionError("The person who started this Run no longer has Agent access", 403);
  await enforceHourlyRunLimits(database, { workspaceId: run.workspaceId, originatorId: run.originatorId, agentId: run.agentId! });
  const [created] = await database.insert(runs).values({
    workspaceId: run.workspaceId, projectId: run.projectId, workItemId: run.workItemId, agentId: run.agentId, originatorId: run.originatorId, commentId: run.commentId, triggerId: run.triggerId, rerunOfId: run.id, attempt,
    freshSession: options.freshSession ?? false,
  }).onConflictDoNothing().returning({ id: runs.id });
  if (!created) return null;
  await enqueueJob(database, { type: "agent_run", payload: { runId: created.id }, dedupeKey: `agent_run:${created.id}` });
  return created.id;
}

/** Retries a Run that failed for a system reason, unless it already used its automatic retries, then starts its work item's Follow-up Run. Call after the Run left the active statuses. */
export async function retryAutomatically(database: Database, run: RunRow) {
  if (run.attempt < maxAutomaticRetries) {
    try { await queueRepeatRun(database, run, run.attempt + 1); }
    catch (error) { if (!(error instanceof ActionError) || (error.status !== 429 && error.status !== 403)) throw error; }
  }
  // The retry (if any) queued first, so it holds the work item's place; otherwise the Follow-up Run starts now.
  if (run.agentId && run.workItemId) await startFollowUpRun(database, run.agentId, run.workItemId);
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
  const stale = await database.transaction(async (transaction) => {
    const tx = transaction as unknown as Database;
    const [row] = await tx.update(runs).set({ status: "stale", failureReason: "worker_crashed", finishedAt: now }).where(and(eq(runs.id, runId), eq(runs.status, "running"))).returning();
    if (row) await emitRunFinished(tx, runId);
    return row;
  });
  if (stale) {
    await retryAutomatically(database, stale);
  }
}

/** Revokes every active Run, leaving running Runtime work in stopping until its Daemon acknowledges cancellation. */
export async function revokeAgentRuns(database: Database, agentId: string, actorId: string, reason: string, originatorId?: string) {
  const active = await database.select().from(runs).where(and(eq(runs.agentId, agentId), ...(originatorId ? [eq(runs.originatorId, originatorId)] : []), inArray(runs.status, ["queued", "dispatched", "running", "stopping", "waiting_confirmation", "awaiting_input", "follow_up"])));
  const now = new Date();
  for (const run of active) {
    await database.transaction(async (transaction) => {
      const tx = transaction as unknown as Database;
      const [current] = await tx.select().from(runs).where(eq(runs.id, run.id)).for("update");
      if (!current || !["queued", "dispatched", "running", "stopping", "waiting_confirmation", "awaiting_input", "follow_up"].includes(current.status)) return;
      const running = ["running", "awaiting_input", "stopping"].includes(current.status);
      const [updated] = await tx.update(runs).set({ status: running ? "stopping" : "failed", failureReason: reason, ...(running ? {} : { finishedAt: now }) })
        .where(eq(runs.id, run.id)).returning();
      if (!updated) return;
      if (!running) {
        await withdrawConfirmations(tx, run.id);
        await emitRunFinished(tx, run.id);
        if (run.agentId && run.workItemId) await startFollowUpRun(tx, run.agentId, run.workItemId);
      }
      if (run.workItemId) await tx.insert(activities).values({
        workspaceId: run.workspaceId, projectId: run.projectId, entityType: "work_item", entityId: run.workItemId,
          field: "run_revoked", oldValue: { status: current.status }, newValue: { status: updated.status, reason }, actorId, source: "ui",
      });
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
    eq(runs.workspaceId, workspaceId), inArray(runs.status, ["queued", "dispatched", "running", "stopping", "waiting_confirmation", "awaiting_input", "follow_up"]),
    or(eq(runs.originatorId, userId), inArray(runs.runtimeId, ownedRuntimes)),
  ));
  const now = new Date();
  for (const run of active) {
    await database.transaction(async (transaction) => {
      const tx = transaction as unknown as Database;
      const [current] = await tx.select().from(runs).where(eq(runs.id, run.id)).for("update");
      if (!current || !["queued", "dispatched", "running", "stopping", "waiting_confirmation", "awaiting_input", "follow_up"].includes(current.status)) return;
      const running = ["running", "awaiting_input", "stopping"].includes(current.status);
      const [updated] = await tx.update(runs).set({ status: running ? "stopping" : "cancelled", failureReason: reason, ...(running ? {} : { finishedAt: now }) })
        .where(eq(runs.id, run.id)).returning();
      if (!updated) return;
      if (!running) {
        await withdrawConfirmations(tx, run.id);
        await emitRunFinished(tx, run.id);
        if (run.agentId && run.workItemId) await startFollowUpRun(tx, run.agentId, run.workItemId);
      }
      if (run.workItemId) await tx.insert(activities).values({
        workspaceId: run.workspaceId, projectId: run.projectId, entityType: "work_item", entityId: run.workItemId,
          field: "run_revoked", oldValue: { status: current.status }, newValue: { status: updated.status, reason }, actorId, source: "ui",
      });
    });
  }
  return active.length;
}

/** Disabling or deleting an Agent cancels queued Runs, while active Runtime work is asked to stop. */
export async function cancelAgentRuns(database: Database, agentId: string, actorId: string, reason: string) {
  const active = await database.select().from(runs).where(and(eq(runs.agentId, agentId), inArray(runs.status, ["queued", "dispatched", "running", "stopping", "waiting_confirmation", "awaiting_input", "follow_up"])));
  const now = new Date();
  for (const run of active) {
    await database.transaction(async (transaction) => {
      const tx = transaction as unknown as Database;
      const [current] = await tx.select().from(runs).where(eq(runs.id, run.id)).for("update");
      if (!current || !["queued", "dispatched", "running", "stopping", "waiting_confirmation", "awaiting_input", "follow_up"].includes(current.status)) return;
      const running = ["running", "awaiting_input", "stopping"].includes(current.status);
      const [updated] = await tx.update(runs).set({ status: running ? "stopping" : "cancelled", failureReason: reason, ...(running ? {} : { finishedAt: now }) })
        .where(eq(runs.id, run.id)).returning();
      if (!updated) return;
      if (!running) {
        await withdrawConfirmations(tx, run.id);
        await emitRunFinished(tx, run.id);
        if (run.agentId && run.workItemId) await startFollowUpRun(tx, run.agentId, run.workItemId);
      }
      if (run.workItemId) await tx.insert(activities).values({
        workspaceId: run.workspaceId, projectId: run.projectId, entityType: "work_item", entityId: run.workItemId,
          field: "run_revoked", oldValue: { status: current.status }, newValue: { status: updated.status, reason }, actorId, source: "ui",
      });
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
      if (run.workItemId) await startFollowUpRun(tx, run.agentId!, run.workItemId);
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
      if (run.workItemId) await startFollowUpRun(tx, agent.id, run.workItemId);
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
        const controlled = await loadControlledRun(tx, context.userId, input.runId);
        const [run] = await tx.select().from(runs).where(eq(runs.id, controlled.id)).for("update");
        if (!run) throw new ActionError("Run not found", 404);
        if (run.status === "stopping") return presentRun(tx, run);
        if (!["queued", "dispatched", "running", "waiting_confirmation", "awaiting_input", followUpStatus].includes(run.status)) throw new ActionError("This Run is not active", 409);
        // A running Run is told to stop; its worker finishes the cancel at the next step boundary.
        const status = ["running", "awaiting_input"].includes(run.status) ? "stopping" : "cancelled";
        const [updated] = await tx.update(runs).set(status === "cancelled" ? { status, finishedAt: new Date() } : { status }).where(and(eq(runs.id, run.id), inArray(runs.status, ["queued", "dispatched", "running", "waiting_confirmation", "awaiting_input", followUpStatus]))).returning();
        if (!updated) throw new ActionError("This Run is not active", 409);
        if (status === "cancelled") {
          await withdrawConfirmations(tx, run.id);
          await emitRunFinished(tx, run.id);
          if (updated.agentId && updated.workItemId) await startFollowUpRun(tx, updated.agentId, updated.workItemId);
        }
        return presentRun(tx, updated!);
      }),
    },
    rerunRun: {
      name: "rerun_run", kind: "write" as const,
      // `newSession` starts the rerun in a new CLI Session instead of resuming the earlier one.
      input: Type.Object({ runId: Type.String({ format: "uuid" }), newSession: Type.Optional(Type.Boolean()) }), output: runOutput,
      handler: async (context: Context, input: { runId: string; newSession?: boolean }) => db.transaction(async (transaction) => {
        const tx = transaction as unknown as Database;
        const run = await loadControlledRun(tx, context.userId, input.runId);
        if (!["failed", "cancelled", "stale"].includes(run.status)) throw new ActionError("Only a failed, cancelled or stale Run can be rerun", 409);
        const [agent] = run.agentId ? await tx.select({ enabled: agents.enabled }).from(agents).where(eq(agents.id, run.agentId)) : [];
        if (!agent?.enabled) throw new ActionError("The Agent is not available", 409);
        await requireProjectAccess(tx, run.originatorId, run.projectId, "write");
        const id = await queueRepeatRun(tx, run, 0, { freshSession: input.newSession === true });
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
