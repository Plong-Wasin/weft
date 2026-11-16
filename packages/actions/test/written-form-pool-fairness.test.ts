import { afterEach, expect, test } from "bun:test";
import * as actions from "../src";
import { prepareRichText } from "../src";
import { pathologicalTexts } from "./support/pathological";

// The pool is shared process state: these tests run one at a time and put its limits back afterwards.
const pool = actions as unknown as {
  configureWrittenFormPool?: (next: Record<string, number>) => void;
  resetWrittenFormPoolConfig?: () => void;
  withWrittenFormKey?: <T>(key: string, run: () => T) => T;
  needsWorker?: (text: string) => boolean;
  writtenFormPoolStats: () => { queuedRequests?: number; queued: number };
};
const keyed = <T>(key: string, run: () => T): T => pool.withWrittenFormKey ? pool.withWrittenFormKey(key, run) : run();
afterEach(() => pool.resetWrittenFormPoolConfig?.());

const hostile = "www.a_".repeat(8_000);
const quick = "See www.example.com for the plan. ".repeat(400);
type Outcome = { ok: boolean; code?: string; status?: number; retryAfter?: number; seconds: number };
const settle = async (run: () => Promise<unknown>): Promise<Outcome> => {
  const started = performance.now();
  try { await run(); return { ok: true, seconds: (performance.now() - started) / 1000 }; }
  catch (error) { const failure = error as { code?: string; status?: number; retryAfter?: number }; return { ok: false, code: failure.code, status: failure.status, retryAfter: failure.retryAfter, seconds: (performance.now() - started) / 1000 }; }
};
const request = (key: string, text: string) => keyed(key, () => settle(() => actions.prepareRichTextGuarded(undefined, text, "body", "bodyMarkdown", {}, "verbatim")));

const dense = (kb: number) => {
  const line = "**bold** and `code` with [a link](https://example.test/x) and ~~strike~~ plus snake_case_word and f(x) ";
  return { type: "doc", content: Array.from({ length: Math.floor(kb * 1024 / 400) }, (_, index) => ({ type: "paragraph", content: [
    { type: "text", text: `item ${index} ${line}`.slice(0, 40), marks: [{ type: "bold" }] }, { type: "text", text: line.repeat(3) }, { type: "text", text: "link", marks: [{ type: "link", attrs: { href: `https://example.test/${index}` } }] },
  ] })) };
};
const bystanderDeadlineSeconds = 4;
// A bystander is served: never refused, never kept waiting past its own deadline. These fail when it is refused `busy` or delayed.
const expectServed = (outcome: Outcome, seconds = bystanderDeadlineSeconds) => { expect({ ok: outcome.ok, code: outcome.code }).toEqual({ ok: true, code: undefined }); expect(outcome.seconds).toBeLessThan(seconds); };

test.serial("20 keys x 1 hostile request each: a normal request that needs the worker is served within its deadline", async () => {
  const attackers = Array.from({ length: 20 }, (_, index) => request(`user:attacker-${index}`, hostile));
  await Bun.sleep(100);
  expectServed(await request("user:bystander", quick));
  await Promise.all(attackers);
}, 120_000);

test.serial("2 keys x 5 hostile requests each: a normal request that needs the worker is served within its deadline", async () => {
  const attackers = [0, 1].flatMap((key) => Array.from({ length: 5 }, () => request(`user:attacker-${key}`, hostile)));
  await Bun.sleep(100);
  expectServed(await request("user:bystander", quick));
  await Promise.all(attackers);
}, 120_000);

test.serial("two callers flooding large ordinary conversions cannot keep a third caller waiting: workers go round-robin by caller", async () => {
  const attackers = [0, 1].flatMap((key) => Array.from({ length: 5 }, () => keyed(`user:flood-${key}`, () => settle(() => actions.prepareRichTextGuarded(dense(150), undefined, "content", "contentMarkdown", {}, "derived")))));
  await Bun.sleep(100);
  const bystander = await keyed("user:bystander", () => settle(() => actions.prepareRichTextGuarded(dense(150), undefined, "content", "contentMarkdown", {}, "derived")));
  expectServed(bystander, 10);
  await Promise.all(attackers);
}, 180_000);

test.serial("suspect input is refused within its short deadline, never after a long wait", async () => {
  const outcomes = await Promise.all(Array.from({ length: 6 }, (_, index) => request(`user:suspect-${index}`, hostile)));
  for (const outcome of outcomes) { expect(outcome.ok).toBe(false); expect(outcome.seconds).toBeLessThan(4.5); }
}, 60_000);

test.serial("the queue is bounded: requests beyond it are refused at once as busy with a retry hint", async () => {
  pool.configureWrittenFormPool?.({ queueLimit: 3 });
  const outcomes = await Promise.all(Array.from({ length: 12 }, (_, index) => request(`caller-${index}`, hostile)));
  const refused = outcomes.filter((outcome) => outcome.code === "busy");
  expect(refused.filter((outcome) => outcome.seconds < 1).length).toBeGreaterThanOrEqual(6);
  for (const outcome of refused) { expect(outcome.status).toBe(429); expect(outcome.retryAfter).toBeGreaterThan(0); }
}, 120_000);

test.serial("one caller has at most one request running and four waiting; another caller is not blocked by it", async () => {
  const same = Array.from({ length: 10 }, () => request("greedy", hostile));
  await Bun.sleep(50);
  const other = await request("polite", quick);
  const outcomes = await Promise.all(same);
  expect(outcomes.filter((outcome) => outcome.code === "busy").length).toBeGreaterThanOrEqual(5);
  expect(other.ok).toBe(true);
  expect(other.seconds).toBeLessThan(3);
}, 120_000);

const liveDocument = (text: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
const live = (page: string, user: string, document: unknown) => settle(() => actions.prepareRichTextGuarded(document, undefined, "content", "contentMarkdown", {}, "derived", {}, { inlineLimit: 0, lane: "live", page, user } as never));

test.serial("a live save completes while every request worker is busy and never gets a 429", async () => {
  const attackers = Array.from({ length: 6 }, (_, index) => request(`user:attacker-${index}`, hostile));
  await Bun.sleep(100);
  const outcome = await live("page-1", "user-1", liveDocument("A live edit with a https://example.com link. ".repeat(300)));
  expect(outcome.ok).toBe(true);
  expect(outcome.seconds).toBeLessThan(2);
  await Promise.all(attackers);
}, 120_000);

test.serial("six pathological live saves do not stop a normal live save", async () => {
  const pathological = liveDocument("[[".repeat(30_000));
  const attackers = Array.from({ length: 6 }, (_, index) => live(`page-bad-${index}`, `user-bad-${index}`, pathological));
  await Bun.sleep(100);
  const normal = await live("page-good", "user-good", liveDocument("A live edit with a https://example.com link. ".repeat(300)));
  expect({ ok: normal.ok, code: normal.code }).toEqual({ ok: true, code: undefined });
  expect(normal.seconds).toBeLessThan(2);
  await Promise.all(attackers);
}, 120_000);

test.serial("one user or one page cannot fill the live lane: the excess saves degrade at once", async () => {
  const slow = liveDocument("[[".repeat(30_000));
  const sameUser = await Promise.all(Array.from({ length: 6 }, (_, index) => live(`page-u-${index}`, "user-flood", slow)));
  expect(sameUser.filter((outcome) => !outcome.ok && outcome.seconds < 1).length).toBeGreaterThanOrEqual(2);
  const samePage = await Promise.all(Array.from({ length: 6 }, (_, index) => live("page-flood", `user-p-${index}`, slow)));
  expect(samePage.filter((outcome) => !outcome.ok && outcome.seconds < 1).length).toBeGreaterThanOrEqual(3);
}, 120_000);

test("inputs of 2 KB that could take long never run in-process; the rest finish within 50 ms inline", () => {
  const worst: Array<{ name: string; ms: number; routed: boolean }> = [];
  for (const [name, text] of Object.entries(pathologicalTexts)) {
    const slice = text.slice(0, 2_048);
    const routed = pool.needsWorker?.(slice) ?? false;
    if (routed) { worst.push({ name, ms: 0, routed }); continue; }
    const started = performance.now();
    try { prepareRichText(undefined, slice, "body", "bodyMarkdown", {}, "verbatim"); } catch { /* a refusal is fine; only the time counts */ }
    worst.push({ name, ms: performance.now() - started, routed });
  }
  expect(worst.filter((entry) => !entry.routed && entry.ms > 50)).toEqual([]);
  expect(pool.needsWorker?.("www.a_".repeat(341))).toBe(true);
  expect(pool.needsWorker?.("=\\\n".repeat(700))).toBe(true);
  expect(pool.needsWorker?.("some `code` here")).toBe(true);
  expect(pool.needsWorker?.("A short plain sentence.")).toBe(false);
});

test.serial("workers go round-robin by caller: B's only job is dispatched before A's second job (recorded dispatch order)", async () => {
  const pooled = actions as unknown as { closeWrittenFormPool: () => void; dispatchLog: string[] };
  pooled.closeWrittenFormPool();
  pool.configureWrittenFormPool?.({ requestWorkers: 1 });
  pooled.dispatchLog.length = 0;
  const text = (label: string) => `run \`x\` ${label} `.repeat(2_500);
  // One worker: A's first job starts at once; A's other three and B's single job wait. Oldest-first would run all of A's before B's.
  const a = [1, 2, 3, 4].map((index) => request("user:A", text(`a${index}`)));
  const b = request("user:B", text("b"));
  const outcomes = await Promise.all([...a, b]);
  expect(outcomes.every((outcome) => outcome.ok)).toBe(true);
  const order = pooled.dispatchLog.filter((key) => key === "user:A" || key === "user:B");
  expect(order).toHaveLength(5);
  expect(order.indexOf("user:B")).toBeLessThan(order.indexOf("user:A", order.indexOf("user:A") + 1));
  pooled.closeWrittenFormPool();
}, 120_000);
