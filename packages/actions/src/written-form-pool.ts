import { AsyncLocalStorage } from "node:async_hooks";
import { ActionError } from "./members";
import { plainTextWrittenForm, prepareRichText, writtenFormOfSync } from "./rich-markdown";
import { documentTableTooLarge, documentTooDeep, WRITTEN_FORM_MAX_NESTING_DEPTH, WRITTEN_FORM_TABLE_TOO_LARGE } from "./written-form-guard";
import { markdownToDocWithWarnings, rawTextDocument, tooManyReferences, WRITTEN_FORM_TOO_MANY_REFERENCES, type MarkdownOptions } from "./markdown-doc";

/**
 * Execution budget of one request job: a base plus a rate per KB of input, capped at 30 s. Measured uncontended, an input of 200,000 characters
 * converts in 0.14 s (Thai prose), 0.85 s (plain words) or 3-4 s (dense bold, links, code, lists, strikethrough); the budget of about 17 s at 200 KB
 * keeps those accepted when the core is shared with other work. The parser cannot report progress from inside a synchronous parse, so this is a wall clock.
 */
export const WRITTEN_FORM_REQUEST_TIMEOUT_MS = 5_000;
export const WRITTEN_FORM_BACKFILL_TIMEOUT_MS = 20_000;
const BACKFILL_RATE_MS_PER_KB = 50;
export function scaledTimeoutMs(size: number, profile: "request" | "backfill" = "request"): number {
  const kilobytes = Math.ceil(size / 1024);
  if (profile === "backfill") return WRITTEN_FORM_BACKFILL_TIMEOUT_MS + BACKFILL_RATE_MS_PER_KB * kilobytes;
  return Math.min(config.timeoutBaseMs + config.timeoutPerKbMs * kilobytes, Math.max(MAX_REQUEST_TIMEOUT_MS, config.timeoutBaseMs));
}
const MAX_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Inputs at most this long run in-process, still behind the raw-text pre-scans. The worst input of this size measured under 50 ms.
 * Anything matching `needsWorker` goes to a worker whatever its size: those are the shapes with quadratic parser cases.
 */
export const WRITTEN_FORM_INLINE_LIMIT = 2 * 1024;
/** Ordinary inputs below this size that need a worker share one worker of their own, so large conversions cannot queue them. */
export const WRITTEN_FORM_SMALL_LIMIT = 16 * 1024;
const NEEDS_WORKER = /www\.|=\\\n|[_*~]{6,}|`|\[\^/;
export const needsWorker = (text: string) => NEEDS_WORKER.test(text);
/**
 * The cheap pre-scan for shapes that are quadratic in the parser: runs of unspaced `www.` tokens, `=\` + newline, fence + backslash, footnote definitions and
 * `[[` openers. Text that matches (as raw Markdown, escaped Markdown or document JSON) goes to the suspect lane: one worker, a short deadline, refused when it does not finish.
 */
const SUSPECT = [
  /(?:www\.\S{0,12}){8,}/, /(?:=\\{1,2}(?:\n|\\n)){16,}/, /(?:```\\+){8,}/, /(?:\[\^[^\]\s]*\]:\S{0,8}\s*){8,}/, /(?:\\?\[){16,}/, /(?:=(?:\n|\\n)){16,}/,
];
export const isSuspect = (text: string) => SUSPECT.some((pattern) => pattern.test(text));

/** A page of versions stops before its Markdown passes this many characters; the cursor continues from the last row returned. */
export const PAGE_MARKDOWN_BUDGET = 1_000_000;

export const TOO_COMPLEX_MESSAGE = "This text is too complex to save. Shorten it or split it.";
export const BUSY_MESSAGE = "The server is busy converting text. Try again in a moment.";
export const CONVERTER_UNAVAILABLE_MESSAGE = "The text converter is unavailable. Try again shortly.";
export const INTERNAL_MESSAGE = "Something went wrong while converting this text. Try again.";

export class WrittenFormTimeout extends Error {
  constructor(readonly timeoutMs: number) { super(`The Written form converter did not finish within ${timeoutMs} ms`); this.name = "WrittenFormTimeout"; }
}
const busy = (retryAfter = 2) => new ActionError(BUSY_MESSAGE, 429, "busy", retryAfter);

export type PoolConfig = {
  /** Workers for ordinary request work (and the backfill). One more serves small inputs, one the suspect lane, one live saves. */
  requestWorkers: number;
  /** Requests allowed to wait for a worker, per lane. */
  queueLimit: number;
  /** Per caller (user): jobs running at once, and jobs waiting. A token is a sub-limit of its user, never a second allowance. */
  perKeyInFlight: number;
  perKeyQueued: number;
  perTokenQueued: number;
  /** A job that has not finished (queue wait included) by then is refused as busy. */
  requestDeadlineMs: number;
  backfillDeadlineMs: number;
  /** Suspect inputs get this deadline, queue wait included. */
  suspectDeadlineMs: number;
  /** Live saves wait here at most, on their own worker that requests never use; per page and per user limits apply. */
  liveQueueLimit: number;
  livePerPageQueued: number;
  livePerUserQueued: number;
  timeoutBaseMs: number;
  timeoutPerKbMs: number;
  /** Every request or live job gets this long on its own lane; a job still running is aborted and moves to the single long lane. */
  probationMs: number;
  /** The long lane: queue wait before a job is refused, jobs a user may have waiting, and the stored-read wait. */
  longDeadlineMs: number;
  longPerUserQueued: number;
  storedDeadlineMs: number;
  /** A request of at least this size goes straight to the long lane when that lane is idle (no probation to waste), if fewer than `directLongQueued` jobs wait there. */
  directLongBytes: number;
  directLongQueued: number;
  /** A job waiting longer than this gains priority with its wait, so a stream of cheaper jobs from fresh callers cannot starve it. */
  agingGraceMs: number;
};
const DEFAULTS: PoolConfig = {
  requestWorkers: 2, queueLimit: 32, perKeyInFlight: 1, perKeyQueued: 4, perTokenQueued: 2, requestDeadlineMs: 10_000, backfillDeadlineMs: 30_000, suspectDeadlineMs: 3_000,
  liveQueueLimit: 64, livePerPageQueued: 1, livePerUserQueued: 2, timeoutBaseMs: WRITTEN_FORM_REQUEST_TIMEOUT_MS, timeoutPerKbMs: 60,
  probationMs: 2_000, longDeadlineMs: 20_000, longPerUserQueued: 2, storedDeadlineMs: 10_000, directLongBytes: 64 * 1024, directLongQueued: 2, agingGraceMs: 5_000,
};
/** Pool limits from the environment: WEFT_WRITTEN_FORM_WORKERS, _QUEUE, _TIMEOUT_BASE_MS, _TIMEOUT_PER_KB_MS. A set but invalid value is an error, not a silent default. */
export function poolConfigFromEnv(env: Record<string, string | undefined>): Partial<PoolConfig> {
  const read = (name: string, min: number, max: number): number | undefined => {
    const raw = env[name];
    if (raw === undefined || raw === "") return undefined;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
    return value;
  };
  const out: Partial<PoolConfig> = {};
  const workers = read("WEFT_WRITTEN_FORM_WORKERS", 1, 8); if (workers !== undefined) out.requestWorkers = workers;
  const queue = read("WEFT_WRITTEN_FORM_QUEUE", 1, 1000); if (queue !== undefined) out.queueLimit = queue;
  const base = read("WEFT_WRITTEN_FORM_TIMEOUT_BASE_MS", 500, 60_000); if (base !== undefined) out.timeoutBaseMs = base;
  const perKb = read("WEFT_WRITTEN_FORM_TIMEOUT_PER_KB_MS", 0, 1_000); if (perKb !== undefined) out.timeoutPerKbMs = perKb;
  return out;
}
const fromEnv = () => ({ ...DEFAULTS, ...poolConfigFromEnv(typeof process !== "undefined" ? process.env : {}) });
let config: PoolConfig = fromEnv();
/** Change the limits (tests, deployments). Idle workers beyond the new size are not recycled; call before load. */
export function configureWrittenFormPool(next: Partial<PoolConfig>) { config = { ...config, ...next }; }
export const resetWrittenFormPoolConfig = () => { config = fromEnv(); };

/** The caller a job is charged to: set once per request, read where the job is queued. The user is the key; the token only a sub-limit. */
type Caller = { key: string; token?: string };
const callerKey = new AsyncLocalStorage<Caller>();
export const withWrittenFormKey = <T>(key: string | undefined, run: () => T, token?: string): T => key ? callerKey.run({ key, token }, run) : run();

type Lane = "request" | "backfill" | "live" | "stored";
/** ordinary / small / suspect / live serve their own kinds of input; long holds jobs that outran probation; stored serves reads of rows already validated on write. */
type Group = "ordinary" | "small" | "suspect" | "live" | "stored" | "long";
const GROUPS: Group[] = ["live", "suspect", "small", "ordinary", "stored", "long"];
type Reply = { id: number; ok: true; value: unknown } | { id: number; ok: false; error: { message: string; status?: number; code?: string; internal?: boolean } };
type Limit = { key: string; inFlight: number; queued: number };
type Job = {
  op: string; args: unknown[]; timeoutMs: number; deadlineAt: number; limits: Limit[]; lane: Lane; group: Group; resolve: (value: unknown) => void; reject: (error: unknown) => void;
  waiter?: ReturnType<typeof setTimeout>;
  /** Who the job is ordered under (round-robin), even when it has no limits (stored reads). */
  orderKey?: string;
  /** Input size; a job under the small limit is taken before a heavy one (a heavy one waits at most for the small ones already queued, which are bounded by the per-caller limits). */
  size?: number;
  /** Fair queuing: the virtual start time of the job, its estimated cost and when it joined the queue. */
  tag?: number; cost?: number; enqueuedAt?: number;
  /** True while the job is on its first lane: it gets `probationMs` there, then moves to the long lane. */
  probation?: boolean;
  /** A batch: one slot, per-item budgets, results reported as they complete. */
  itemTimeouts?: number[]; partial?: unknown[];
};
type Running = Job & { id: number; timer?: ReturnType<typeof setTimeout>; clipped: boolean; armedAt?: number };
type Slot = { worker: Worker; group: Group; job: Running | null; ready: boolean; arm?: () => void; fallback?: ReturnType<typeof setTimeout> };

/** A batch that ran out of time on one item: the items before it are done. */
export class WrittenFormBatchTimeout extends Error {
  constructor(readonly done: unknown[], readonly timeoutMs: number) { super(`The Written form converter did not finish item ${done.length} within ${timeoutMs} ms`); this.name = "WrittenFormBatchTimeout"; }
}

let nextId = 1;
const slots: Slot[] = [];
const queues: Record<Group, Job[]> = { ordinary: [], small: [], suspect: [], live: [], stored: [], long: [] };
/** Start-time fair queuing: a virtual clock per lane, and the virtual time each caller has been scheduled up to. A newcomer starts at the clock, so it is scheduled by arrival, not behind every untouched account. */
const virtualTime: Record<Group, number> = { ordinary: 0, small: 0, suspect: 0, live: 0, stored: 0, long: 0 };
const finishTag = new Map<string, number>();
/** Callers whose job timed out on its whole budget: demoted until the time given, with one waiting job per lane. */
const demotedUntil = new Map<string, number>();
const DEMOTION_MS = 60_000, DEMOTION_COST = 500, AGING_UNITS_PER_SECOND = 100;
const isDemoted = (key: string | undefined) => !!key && (demotedUntil.get(key) ?? 0) > Date.now();
/** What a job is expected to cost the converter, in KB-like units: its size, scaled up by the density of the characters the quadratic shapes are made of. */
export function estimateCost(size: number, text?: string): number {
  const kb = Math.max(size, 1) / 1024;
  if (!text) return Math.max(kb, 1);
  const sample = text.length > 20_000 ? text.slice(0, 20_000) : text;
  let special = 0;
  for (let index = 0; index < sample.length; index++) if ("_*[]()~`\\<>!|&".includes(sample[index]!)) special++;
  special += (sample.match(/www\./gi)?.length ?? 0) * 4;
  return Math.max(kb * (1 + 4 * special / Math.max(sample.length, 1)), 1);
}
function demote(key: string | undefined) {
  if (!key) return;
  demotedUntil.set(key, Date.now() + DEMOTION_MS);
  for (const group of GROUPS) finishTag.set(`${group}:${key}`, Math.max(finishTag.get(`${group}:${key}`) ?? 0, virtualTime[group]) + DEMOTION_COST);
  if (demotedUntil.size > 5_000) for (const [other, until] of demotedUntil) if (until < Date.now()) demotedUntil.delete(other);
}
function tag(job: Job) {
  const key = job.orderKey ?? job.limits[0]?.key ?? "anonymous";
  const slot = `${job.group}:${key}`;
  const start = Math.max(virtualTime[job.group], finishTag.get(slot) ?? 0);
  job.tag = start; job.enqueuedAt = Date.now();
  finishTag.set(slot, start + (job.cost ?? 1));
  if (finishTag.size > 10_000) for (const [other, value] of finishTag) if (value < virtualTime[job.group] - 1_000) finishTag.delete(other);
}
/** Recorded dispatch order (test hook): the order key of each job as a worker took it. */
export const dispatchLog: string[] = [];
let respawns = 0;
let rejectedBusy = 0;
let jobsRun = 0;
let movedToLong = 0;
/** The longest a job has held a worker of each lane, from the moment its clock started until it finished or was aborted. */
const maxHoldMs: Record<Group, number> = { ordinary: 0, small: 0, suspect: 0, live: 0, stored: 0, long: 0 };
const recordHold = (running: Running) => { if (running.armedAt !== undefined && running.op !== "warm") maxHoldMs[running.group] = Math.max(maxHoldMs[running.group], Date.now() - running.armedAt); };
export const resetWrittenFormPoolHolds = () => { for (const group of GROUPS) maxHoldMs[group] = 0; };
export const writtenFormPoolStats = () => ({ respawns, workers: slots.length, queued: GROUPS.reduce((sum, group) => sum + queues[group].length, 0), queuedRequests: queues.ordinary.length + queues.small.length + queues.suspect.length, rejectedBusy, jobsRun, movedToLong, maxHoldMs: { ...maxHoldMs } });

function spawn(): Worker {
  const worker = new Worker(new URL("./written-form-worker.ts", import.meta.url).href);
  (worker as unknown as { unref?: () => void }).unref?.();
  return worker;
}

function replace(slot: Slot) {
  clearTimeout(slot.fallback);
  try { slot.worker.terminate(); } catch { /* already gone */ }
  slot.worker = spawn();
  slot.job = null;
  slot.ready = false;
  slot.arm = undefined;
  respawns++;
  rebind(slot);
}

/** Stop every worker and forget queued work (a script that is done with the pool, and tests). */
export function closeWrittenFormPool() {
  for (const group of GROUPS) { for (const job of queues[group].splice(0)) { clearTimeout(job.waiter); job.reject(unavailable("the pool was closed")); } }
  for (const slot of slots.splice(0)) { clearTimeout(slot.fallback); clearTimeout(slot.job?.timer); try { slot.worker.terminate(); } catch { /* gone */ } slot.job?.reject(unavailable("the pool was closed")); }
}

function unavailable(detail: string) {
  console.error(`Written form worker failed: ${detail}`);
  return new ActionError(CONVERTER_UNAVAILABLE_MESSAGE, 503, "converter-unavailable", 5);
}

function rebind(slot: Slot) {
  const worker = slot.worker;
  worker.onmessage = (event: MessageEvent<Reply | { ready: true } | { id: number; progress: { index: number; value: unknown } }>) => {
    const data = event.data;
    if ("ready" in data) { slot.ready = true; clearTimeout(slot.fallback); const arm = slot.arm; slot.arm = undefined; arm?.(); return; }
    if ("progress" in data) {
      const running = slot.job;
      if (!running || running.id !== data.id || !running.partial) return;
      running.partial[data.progress.index] = data.progress.value;
      // The next item starts now: its own budget, so one slow row costs only itself.
      slot.arm = undefined;
      armTimer(slot, running, running.itemTimeouts?.[data.progress.index + 1] ?? running.timeoutMs);
      return;
    }
    const reply = data;
    const job = slot.job;
    if (!job || job.id !== reply.id) return;
    clearTimeout(job.timer);
    recordHold(job);
    slot.job = null;
    // A batch reports each item as it finishes; the final reply only closes it.
    if (reply.ok) job.resolve(job.partial ?? reply.value);
    else {
      const failure = reply.error;
      if (failure.internal) { console.error(`Written form converter failed: ${failure.message}`); job.reject(new ActionError(INTERNAL_MESSAGE, 500, "internal-error")); }
      else job.reject(new ActionError(failure.message, (failure.status ?? 400) as 400, failure.code));
    }
    drain();
  };
  worker.onerror = (event: ErrorEvent) => {
    const job = slot.job;
    event.preventDefault?.();
    if (job) clearTimeout(job.timer);
    replace(slot);
    if (job) job.reject(unavailable(event.message));
    drain();
  };
}

const workersOf = (group: Group) => group === "ordinary" ? config.requestWorkers : 1;
function ensureSlot(group: Group): Slot | undefined {
  const own = slots.filter((slot) => slot.group === group);
  const free = own.find((slot) => !slot.job);
  if (free) return free;
  if (own.length >= workersOf(group)) return undefined;
  const slot: Slot = { worker: spawn(), group, job: null, ready: false };
  rebind(slot);
  slots.push(slot);
  return slot;
}

const runningFor = (key: string) => slots.reduce((count, slot) => count + (slot.job?.limits.some((limit) => limit.key === key) ? 1 : 0), 0);
const underLimits = (job: { limits: Limit[] }) => job.limits.every((limit) => runningFor(limit.key) < limit.inFlight);

/**
 * The next job a worker may take, among the callers under their running limits: the smallest virtual start time (fair queuing by cost), less a credit that grows with the time a job has
 * waited (aging, after a grace of five seconds, longer than a chain of probations, so that a burst of equal arrivals is still ordered by cost, so a heavy job is never starved by a stream of small ones), ties to the cheaper job and then the older one.
 */
function pick(queue: Job[]): Job | undefined {
  let best = -1, bestRank = Infinity, bestCost = Infinity, bestAt = Infinity;
  const now = Date.now();
  for (let index = 0; index < queue.length; index++) {
    const job = queue[index]!;
    if (!underLimits(job)) continue;
    // A demoted caller waits its penalty out: aging would hand an attacker looping on the long lane the priority its own queue time earns, ahead of everyone else.
    const aging = isDemoted(job.orderKey ?? job.limits[0]?.key) ? 0 : (Math.max(now - (job.enqueuedAt ?? now) - config.agingGraceMs, 0) / 1000) * AGING_UNITS_PER_SECOND;
    const rank = (job.tag ?? 0) - aging;
    const cost = job.cost ?? 1, at = job.enqueuedAt ?? 0;
    if (rank < bestRank || (rank === bestRank && (cost < bestCost || (cost === bestCost && at < bestAt)))) { best = index; bestRank = rank; bestCost = cost; bestAt = at; }
  }
  if (best < 0) return undefined;
  const [job] = queue.splice(best, 1);
  virtualTime[job!.group] = Math.max(virtualTime[job!.group], job!.tag ?? 0);
  const key = job!.orderKey ?? job!.limits[0]?.key;
  dispatchLog.push(key ?? "");
  if (dispatchLog.length > 1_000) dispatchLog.splice(0, 500);
  return job;
}

/** What a job that cannot be served says: a read or a live save degrades, a request is told to retry. */
const refusal = (job: { lane: Lane; timeoutMs: number }) => job.lane === "live" || job.lane === "stored" || job.lane === "backfill" ? new WrittenFormTimeout(job.timeoutMs) : busy();

function expireWaiting(job: Job, queue: Job[]) {
  const index = queue.indexOf(job);
  if (index < 0) return;
  queue.splice(index, 1);
  rejectedBusy++;
  job.reject(refusal(job));
}

function armTimer(slot: Slot, running: Running, ms: number) {
  clearTimeout(running.timer);
  running.armedAt ??= Date.now();
  const id = running.id;
  const base = running.clipped ? Math.min(ms, Math.max(running.deadlineAt - Date.now(), 1)) : ms;
  // Probation: a job that has not finished within `probationMs` is aborted and waits on the long lane instead of holding this worker for its whole budget.
  const probation = !!running.probation && !running.itemTimeouts && running.timeoutMs > config.probationMs && config.probationMs < base ? config.probationMs : undefined;
  const limit = probation ?? base;
  const onProbation = probation !== undefined;
  running.timer = setTimeout(() => {
    // Hard stop: the thread is killed, not asked to stop, and a fresh one takes its place.
    const current = slot.job;
    if (!current || current.id !== id) return;
    recordHold(running);
    replace(slot);
    // A caller whose job outran its whole budget is demoted: its next jobs go behind everyone else. Outrunning probation alone does not demote: a large legitimate document does that
    // too, and demoting it would put the rest of its own save behind an attacker's backlog. The job moves to the long lane, and a timeout there demotes it.
    if (running.lane !== "stored" && !onProbation) demote(running.orderKey ?? running.limits[0]?.key);
    if (onProbation) { moveToLong(running); return; }
    if (running.partial) running.reject(new WrittenFormBatchTimeout(running.partial.filter((_, index) => index in running.partial!), ms));
    else if (running.clipped && running.lane === "request" && running.group !== "suspect") { rejectedBusy++; running.reject(busy()); }
    else running.reject(new WrittenFormTimeout(running.timeoutMs));
    drain();
  }, limit);
}

/** A job that outran probation was aborted: it waits on the long lane (one worker, one running job per user) for its full budget. */
function moveToLong(running: Running) {
  movedToLong++;
  const { id: _id, timer: _timer, clipped: _clipped, armedAt: _armedAt, ...job } = running;
  const user = job.limits[0]?.key;
  // A caller that timed out in the last minute is demoted: its job gets the base budget on the long lane, without the allowance for its size, so a loop of pathological inputs
  // holds the single long worker for seconds instead of tens of seconds.
  const timeoutMs = isDemoted(job.orderKey ?? user) ? Math.min(job.timeoutMs, config.timeoutBaseMs) : job.timeoutMs;
  const next: Job = { ...job, timeoutMs, group: "long", probation: false, limits: user ? [{ key: user, inFlight: 1, queued: config.longPerUserQueued }] : [], deadlineAt: Date.now() + config.longDeadlineMs + timeoutMs };
  const queued = (limit: Limit) => queues.long.reduce((count, other) => count + (other.limits.some((entry) => entry.key === limit.key) ? 1 : 0), 0);
  if (queues.long.length >= config.queueLimit || next.limits.some((limit) => queued(limit) >= limit.queued + 1)) { rejectedBusy++; next.reject(refusal(next)); drain(); return; }
  next.waiter = setTimeout(() => expireWaiting(next, queues.long), config.longDeadlineMs);
  (next.waiter as unknown as { unref?: () => void }).unref?.();
  tag(next);
  queues.long.push(next);
  drain();
}

function start(slot: Slot, job: Job) {
  clearTimeout(job.waiter);
  const id = nextId++;
  jobsRun++;
  const remaining = job.deadlineAt - Date.now();
  if (remaining <= 0) { rejectedBusy++; job.reject(refusal(job)); return false; }
  const first = job.itemTimeouts?.[0] ?? job.timeoutMs;
  const clipped = remaining < first;
  // The clock starts when the thread is ready (a cold or replaced worker still has to load its module), not when the job is handed over.
  const running: Running = { ...job, id, clipped };
  slot.job = running;
  const arm = () => { if (slot.job === running) armTimer(slot, running, first); };
  try { slot.worker.postMessage({ id, op: job.op, args: job.args }); }
  catch (error) { slot.job = null; job.reject(unavailable(error instanceof Error ? error.message : String(error))); return false; }
  if (slot.ready) arm();
  else {
    slot.arm = arm;
    // A worker that never reports ready still gets its job timed; the timer is cleared the moment it is ready, so it never holds the process open.
    slot.fallback = setTimeout(() => { if (slot.arm === arm) { slot.arm = undefined; arm(); } }, 5_000);
  }
  return true;
}

function drain() {
  for (const group of GROUPS) {
    for (;;) {
      if (!queues[group].length) break;
      const slot = ensureSlot(group);
      if (!slot) break;
      const job = pick(queues[group]);
      if (!job) break;
      start(slot, job);
    }
  }
}

/** Start the workers now, so the first save does not pay for a cold thread. */
export async function warmWrittenFormPool(): Promise<void> {
  const warm = (group: Group) => runInWorker<boolean>("warm", [], { group, timeoutMs: 10_000, deadlineMs: 10_000 }).catch(() => false);
  await Promise.all([...Array.from({ length: config.requestWorkers }, () => warm("ordinary")), warm("small"), warm("suspect"), warm("live"), warm("stored"), warm("long")]);
}

export type RunOptions = {
  timeoutMs?: number; inlineLimit?: number; lane?: Lane; deadlineMs?: number; size?: number;
  /** The text being converted (Markdown, or the document as JSON): used to pick the lane. */
  text?: string;
  /** Live saves: the page and the user the save is charged to. */
  page?: string; user?: string;
  /** Overrides the caller taken from the request context. */
  key?: string; group?: Group;
  /** Batch: the size of each item, so each gets its own budget. */
  itemSizes?: number[];
};

/** Run one converter operation on a worker thread with a hard timeout and a deadline that includes the queue wait. */
export function runInWorker<T>(op: "prepare" | "writtenForm" | "parse" | "storedRead" | "storedReadMany" | "warm", args: unknown[], run: RunOptions | number = {}): Promise<T> {
  const options: RunOptions = typeof run === "number" ? { timeoutMs: run } : run;
  const lane = options.lane ?? "request";
  const stored = lane === "stored";
  const suspect = (lane === "request" || lane === "live") && options.text !== undefined && isSuspect(options.text);
  let group: Group = options.group ?? (stored ? "stored" : lane === "backfill" ? "ordinary" : suspect ? "suspect" : lane === "live" ? "live" : (options.size ?? 0) < WRITTEN_FORM_SMALL_LIMIT ? "small" : "ordinary");
  // A heavy request (not from a demoted caller) meets an idle long lane: it goes there directly, so the 2 s of probation are not thrown away and it holds no ordinary worker.
  if (lane === "request" && !options.group && group === "ordinary" && (options.size ?? 0) >= config.directLongBytes && !isDemoted(options.key ?? callerKey.getStore()?.key) && queues.long.length < config.directLongQueued && !slots.some((slot) => slot.group === "long" && slot.job)) group = "long";
  const profile = lane === "backfill" ? "backfill" : "request";
  const itemTimeouts = options.itemSizes?.map((size) => scaledTimeoutMs(size, profile));
  const timeoutMs = options.timeoutMs ?? (itemTimeouts ? itemTimeouts.reduce((sum, ms) => sum + ms, 0) : group === "suspect" ? Math.min(config.suspectDeadlineMs, scaledTimeoutMs(options.size ?? 0, profile)) : scaledTimeoutMs(options.size ?? 0, profile));
  const deadlineMs = options.deadlineMs ?? (stored ? config.storedDeadlineMs : group === "long" ? config.longDeadlineMs : group === "suspect" ? config.suspectDeadlineMs : lane === "backfill" ? config.backfillDeadlineMs : config.requestDeadlineMs);
  const caller = callerKey.getStore();
  const limits: Limit[] = [];
  let orderKey: string | undefined;
  if (lane === "request") {
    const key = options.key ?? caller?.key;
    if (key) limits.push({ key, inFlight: config.perKeyInFlight, queued: isDemoted(key) ? 1 : config.perKeyQueued });
    if (caller?.token && !options.key) limits.push({ key: `token:${caller.token}`, inFlight: config.perKeyInFlight, queued: config.perTokenQueued });
  } else if (lane === "live") {
    if (options.page) limits.push({ key: `page:${options.page}`, inFlight: 1, queued: config.livePerPageQueued });
    if (options.user) limits.push({ key: `user:${options.user}`, inFlight: 1, queued: isDemoted(`user:${options.user}`) ? 1 : config.livePerUserQueued });
    // Saves are taken round-robin by user, so one user's many pages cannot go ahead of everyone else.
    orderKey = options.user ? `user:${options.user}` : options.page ? `page:${options.page}` : undefined;
  } else if (stored) orderKey = options.key ?? caller?.key;
  const queue = queues[group];
  return new Promise<T>((resolve, reject) => {
    const job: Job = {
      op, args, timeoutMs, deadlineAt: Date.now() + Math.max(deadlineMs, timeoutMs), limits, lane, group, resolve: resolve as (value: unknown) => void, reject, orderKey, size: options.size, cost: estimateCost(options.size ?? 0, options.text),
      probation: lane !== "backfill" && op !== "warm" && (group === "ordinary" || group === "small" || group === "live"), itemTimeouts, partial: itemTimeouts ? [] : undefined,
    };
    // Stored reads are never refused for load: a row was validated when it was written, so a read waits (up to its deadline, then degrades to the raw text).
    if (!stored && group !== "stored" && lane !== "backfill") {
      const wouldWait = !slotAvailable(group, job);
      const queuedFor = (limit: Limit) => queue.reduce((count, other) => count + (other.limits.some((entry) => entry.key === limit.key) ? 1 : 0), 0);
      const full = group === "live" ? config.liveQueueLimit : config.queueLimit;
      if (wouldWait && (queue.length >= full || limits.some((limit) => queuedFor(limit) >= limit.queued))) { rejectedBusy++; reject(refusal(job)); return; }
    }
    // A job that never reaches a worker is refused at its deadline.
    job.waiter = setTimeout(() => expireWaiting(job, queue), Math.max(deadlineMs, timeoutMs));
    (job.waiter as unknown as { unref?: () => void }).unref?.();
    tag(job);
    queue.push(job);
    drain();
  });
}

/** True when a job would start at once: a free (or still spawnable) worker in its lane and its caller under every running limit. */
function slotAvailable(group: Group, job: { limits: Limit[] }): boolean {
  if (!underLimits(job)) return false;
  const own = slots.filter((slot) => slot.group === group);
  return own.some((slot) => !slot.job) || own.length < workersOf(group);
}

type Prepare = typeof prepareRichText;
const tooComplex = () => new ActionError(TOO_COMPLEX_MESSAGE, 400, "input-too-complex");
const tooDeep = () => new ActionError(`This text is nested too deeply to save safely; reduce the nesting below ${WRITTEN_FORM_MAX_NESTING_DEPTH} levels.`, 400, "nesting-too-deep");
/** Options travel to a worker as data: the resolver function is dropped and rebuilt from `references`. */
const portable = (options: MarkdownOptions) => { const { resolveReference, ...rest } = options; return { rest, canTravel: !resolveReference || !!options.references }; };

/** Size in characters and the text itself (the Markdown, or the document as JSON); a document too deep to serialise counts as too deep, not as a crash. */
function inspect(document: unknown, markdown: unknown): { size: number; text: string } {
  if (typeof markdown === "string") return { size: markdown.length, text: markdown };
  if (document === undefined) return { size: 0, text: "" };
  if (documentTooDeep(document)) throw tooDeep();
  try { const text = JSON.stringify(document) ?? ""; return { size: text.length, text }; }
  catch (error) { if (error instanceof RangeError) throw tooDeep(); throw error; }
}
const mustLeaveInline = (input: { size: number; text: string }, limit: number) => input.size > limit || needsWorker(input.text);

/**
 * prepareRichText, guarded: small inputs run in-process; anything larger (or `inlineLimit: 0`) runs on a worker with a hard wall-clock timeout.
 * A timeout refuses with the plain `input-too-complex` message; the worker is killed and replaced.
 */
export async function prepareRichTextGuarded(document: unknown, markdown: unknown, documentName: string, markdownName: string, options: MarkdownOptions = {}, storage: Parameters<Prepare>[5] = "derived", policy: Parameters<Prepare>[6] = {}, run: RunOptions = {}): Promise<ReturnType<Prepare>> {
  const input = inspect(document, markdown);
  // Counted before any queueing: a text dense with [[references]] is refused at once, not after a wait for a worker.
  if (typeof markdown === "string" && tooManyReferences(markdown)) throw new ActionError(WRITTEN_FORM_TOO_MANY_REFERENCES, 400, "input-too-complex");
  if (typeof markdown !== "string" && documentTableTooLarge(document)) throw new ActionError(WRITTEN_FORM_TABLE_TOO_LARGE, 400, "input-too-complex");
  const { rest, canTravel } = portable(options);
  if (!mustLeaveInline(input, run.inlineLimit ?? WRITTEN_FORM_INLINE_LIMIT) || !canTravel) return prepareRichText(document, markdown, documentName, markdownName, options, storage, policy);
  try { return await runInWorker<ReturnType<Prepare>>("prepare", [document, markdown, documentName, markdownName, rest, storage, policy], { ...run, size: input.size, text: input.text }); }
  catch (error) { if (error instanceof WrittenFormTimeout) throw tooComplex(); throw error; }
}

/**
 * Written form of a document for reads and derived columns: verified and escalating, and never able to stall the event loop.
 * On a timeout it serves the escaped plain-text form unless the caller supplies the stored Markdown to fall back to.
 */
export async function writtenFormOf(document: unknown, run: RunOptions & { fallback?: string } = {}): Promise<string> {
  const input = inspect(document, undefined);
  if (!mustLeaveInline(input, run.inlineLimit ?? WRITTEN_FORM_INLINE_LIMIT)) return writtenFormOfSync(document);
  try { return await runInWorker<string>("writtenForm", [document], { ...run, size: input.size, text: input.text }); }
  catch (error) {
    if (!(error instanceof WrittenFormTimeout)) throw error;
    if (run.fallback !== undefined) return run.fallback;
    console.warn("Written form verification timed out; serving the escaped plain-text form");
    return plainTextWrittenForm(document);
  }
}

/**
 * The documents of stored Written forms, for reads, with the parse warnings: ONE worker job for all rows that need one (small plain rows parse in-process).
 * A stored row was validated when it was written, so a read is never refused for load: it waits on its own lane up to its deadline, and what cannot be parsed in time is shown as its raw text.
 * Each item has its own budget; a row that outruns it is shown raw and the rest are resubmitted, so one slow row costs only itself.
 */
export async function storedDocumentsWithWarnings(items: Array<{ markdown: string; options?: MarkdownOptions }>, run: RunOptions = {}): Promise<Array<ReturnType<typeof rawTextDocument>>> {
  const results: Array<ReturnType<typeof rawTextDocument>> = new Array(items.length);
  let remote: number[] = [];
  items.forEach((item, index) => {
    const options = item.options ?? {};
    if (!mustLeaveInline({ size: item.markdown.length, text: item.markdown }, run.inlineLimit ?? WRITTEN_FORM_INLINE_LIMIT) || !portable(options).canTravel) results[index] = markdownToDocWithWarnings(item.markdown, { ...options, storedRead: true }) as ReturnType<typeof rawTextDocument>;
    else remote.push(index);
  });
  while (remote.length) {
    const batch = remote;
    try {
      const out = await runInWorker<Array<ReturnType<typeof rawTextDocument>>>("storedReadMany", [batch.map((index) => ({ markdown: items[index]!.markdown, options: portable(items[index]!.options ?? {}).rest }))], { ...run, lane: "stored", itemSizes: batch.map((index) => items[index]!.markdown.length) });
      batch.forEach((index, position) => { results[index] = out[position]!; });
      return results;
    } catch (error) {
      if (error instanceof WrittenFormBatchTimeout) {
        const finished = error.done.length;
        batch.slice(0, finished).forEach((index, position) => { results[index] = error.done[position] as ReturnType<typeof rawTextDocument>; });
        const slow = batch[finished]!;
        console.warn("Stored Written form parse timed out; serving the raw text");
        results[slow] = rawTextDocument(items[slow]!.markdown);
        remote = batch.slice(finished + 1);
        continue;
      }
      if (error instanceof WrittenFormTimeout) {
        console.warn("Stored Written form parse did not start in time; serving the raw text");
        for (const index of batch) results[index] ??= rawTextDocument(items[index]!.markdown);
        return results;
      }
      throw error;
    }
  }
  return results;
}
export async function storedDocumentWithWarnings(markdown: string, options: MarkdownOptions = {}, run: RunOptions = {}): Promise<ReturnType<typeof rawTextDocument>> {
  return (await storedDocumentsWithWarnings([{ markdown, options }], run))[0]!;
}
export const storedDocumentOf = async (markdown: string, options: MarkdownOptions = {}, run: RunOptions = {}) => (await storedDocumentWithWarnings(markdown, options, run)).document;
/** The Written form of a stored document for a read: on the stored lane (never refused), and the stored text when it cannot be produced in time. */
export const readWrittenFormOf = (document: unknown, fallback?: string) => writtenFormOf(document, { lane: "stored", ...(fallback !== undefined ? { fallback } : {}) });

/** A stored document for a synchronous caller: small plain text parses in-process, anything else is shown as its raw text (never a main-thread parse of a heavy row). */
export function inlineStoredDocument(markdown: string, options: MarkdownOptions = {}): ReturnType<typeof rawTextDocument>["document"] {
  return mustLeaveInline({ size: markdown.length, text: markdown }, WRITTEN_FORM_INLINE_LIMIT) ? rawTextDocument(markdown).document : markdownToDocWithWarnings(markdown, { ...options, storedRead: true }).document;
}

/** Untrusted Markdown to a document: small plain text parses in-process, the rest on a worker; a timeout refuses it as too complex. */
export async function parseMarkdownGuarded(markdown: string, options: MarkdownOptions = {}, run: RunOptions = {}): Promise<ReturnType<typeof markdownToDocWithWarnings>> {
  const { rest, canTravel } = portable(options);
  if (!mustLeaveInline({ size: markdown.length, text: markdown }, WRITTEN_FORM_INLINE_LIMIT) || !canTravel) return markdownToDocWithWarnings(markdown, options);
  try { return await runInWorker<ReturnType<typeof markdownToDocWithWarnings>>("parse", [markdown, rest], { ...run, size: markdown.length, text: markdown }); }
  catch (error) { if (error instanceof WrittenFormTimeout) throw tooComplex(); throw error; }
}
