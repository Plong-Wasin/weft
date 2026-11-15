import { afterEach, expect, test } from "bun:test";
import * as actions from "../src";

// Accounts are free, so a flood of fresh accounts must not push a normal caller behind every one of them: callers are scheduled by a virtual clock and a cost estimate (a newcomer is
// scheduled by arrival, not behind every untouched account), a caller whose job outran probation is demoted, and a waiting job's priority rises with its wait. Probation is shortened so the test is quick.
const pool = actions as unknown as {
  configureWrittenFormPool: (next: Record<string, number>) => void; resetWrittenFormPoolConfig: () => void; resetWrittenFormPoolHolds?: () => void;
  withWrittenFormKey: <T>(key: string, run: () => T) => T;
};
afterEach(() => pool.resetWrittenFormPoolConfig());
// A short probation and short budgets: an attacker that outruns probation dies quickly on the long lane too, so the tests take seconds.
const QUICK = { probationMs: 500, timeoutBaseMs: 500, timeoutPerKbMs: 0, longDeadlineMs: 3_000 };

const shapes: Record<string, string> = {
  "www15_": ("www." + "a".repeat(15) + "_").repeat(9_500),
  "_a": "_a".repeat(95_000),
};
const normal = "A normal paragraph about the plan, with a https://example.com link and f(x). ".repeat(520).slice(0, 40_000);
const document = (text: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
type Outcome = { ok: boolean; code?: string; seconds: number };
const settle = async (run: () => Promise<unknown>): Promise<Outcome> => {
  const started = performance.now();
  try { await run(); return { ok: true, seconds: (performance.now() - started) / 1000 }; }
  catch (error) { return { ok: false, code: (error as { code?: string }).code, seconds: (performance.now() - started) / 1000 }; }
};
const request = (user: string, text: string) => pool.withWrittenFormKey(`user:${user}`, () => settle(() => actions.prepareRichTextGuarded(undefined, text, "body", "bodyMarkdown", {}, "verbatim")));
const live = (user: string, text: string) => settle(() => actions.prepareRichTextGuarded(document(text), undefined, "content", "contentMarkdown", {}, "derived", {}, { inlineLimit: 0, lane: "live", page: `page-${user}`, user } as never));

for (const lane of ["live", "request"] as const) {
  for (const [shape, text] of Object.entries(shapes)) {
    // The request lane has two workers, so only a flood of 12 accounts shows a queue; the live lane has one.
    for (const accounts of lane === "live" ? [6, 12] : [12]) {
      test.serial(`${accounts} fresh ${lane} accounts with "${shape}": a normal 40 KB ${lane} job is served at once, not behind them`, async () => {
        pool.configureWrittenFormPool(QUICK);
        const run = lane === "live" ? live : request;
        const attackers = Array.from({ length: accounts }, (_, index) => run(`attacker-${lane}-${shape}-${index}`, text));
        await Bun.sleep(100);
        const served = await run(`bystander-${lane}-${shape}-${accounts}`, normal);
        expect({ ok: served.ok, code: served.code }).toEqual({ ok: true, code: undefined });
        // Behind the attackers it would wait about (accounts - workers) x 0.5 s; scheduled by arrival and cost it waits for the job that is running at most.
        expect(served.seconds).toBeLessThan(1.5);
        await Promise.all(attackers);
      }, 120_000);
    }
  }
}

test.serial("a caller whose job outran probation is demoted: its next job goes behind everyone and it may queue only one per lane for a while", async () => {
  pool.configureWrittenFormPool(QUICK);
  const attacker = "demoted-user";
  const first = await request(attacker, shapes["_a"]!);
  expect(first.ok || first.code === "input-too-complex").toBe(true);
  // Its next three jobs: one may wait, the others are refused at once as busy.
  const burst = await Promise.all(Array.from({ length: 4 }, () => request(attacker, shapes["_a"]!)));
  expect(burst.filter((outcome) => outcome.code === "busy").length).toBeGreaterThanOrEqual(2);
  // A bystander arriving after the burst began is served before the demoted caller's waiting job.
  const flood = [request(attacker, shapes["_a"]!)];
  await Bun.sleep(50);
  const served = await request("bystander-demotion", normal);
  expect(served.ok).toBe(true);
  expect(served.seconds).toBeLessThan(1.0);
  await Promise.all(flood);
}, 120_000);

test.serial("aging: a heavy save behind a continuous stream of small saves from fresh accounts is dispatched within its aging bound, while the stream still runs", async () => {
  // Every small save comes from a fresh caller, so each starts at the same virtual time as the heavy one and, being cheaper, wins every tie: only aging can dispatch the heavy job.
  pool.configureWrittenFormPool({ ...QUICK, agingGraceMs: 300 });
  const small = "A live edit with a https://example.com link. ".repeat(300);
  let stopping = false, counter = 0, served = 0;
  const stream = Array.from({ length: 4 }, () => (async () => { while (!stopping) { if ((await live(`fresh-${counter++}`, small)).ok) served++; } })());
  await Bun.sleep(200);
  const started = performance.now();
  const heavy = await live("heavy-user", normal);
  const heavySeconds = (performance.now() - started) / 1000;
  const streamStillRunning = !stopping;
  stopping = true;
  await Promise.all(stream);
  expect({ ok: heavy.ok, code: heavy.code }).toEqual({ ok: true, code: undefined });
  expect(served).toBeGreaterThan(5);
  expect(streamStillRunning).toBe(true);
  // Aging grace 0.3 s plus the time of the job in flight: far below the 10 s a refused heavy save would wait.
  expect(heavySeconds).toBeLessThan(2);
}, 120_000);

test.serial("system callers carry a key and are limited like a user: a burst under system:worker is refused beyond the per-caller queue", async () => {
  pool.configureWrittenFormPool(QUICK);
  const burst = await Promise.all(Array.from({ length: 9 }, () => pool.withWrittenFormKey("system:worker", () => settle(() => actions.prepareRichTextGuarded(undefined, shapes["_a"]!, "body", "bodyMarkdown", {}, "verbatim")))));
  expect(burst.filter((outcome) => outcome.code === "busy").length).toBeGreaterThanOrEqual(3);
}, 120_000);

test("the AI chat and the worker run their actions under system keys", async () => {
  const { readFileSync } = await import("node:fs");
  const root = new URL("../../..", import.meta.url).pathname;
  expect(readFileSync(`${root}packages/actions/src/ai-chats.ts`, "utf8")).toContain('withWrittenFormKey("system:ai-chat"');
  expect(readFileSync(`${root}apps/worker/src/index.ts`, "utf8")).toContain('withWrittenFormKey("system:worker"');
});

test.serial("a heavy request goes straight to an idle long lane (no probation wasted), and two accounts looping on the long lane do not refuse another account's heavy request", async () => {
  pool.configureWrittenFormPool({ probationMs: 1, timeoutBaseMs: 800, timeoutPerKbMs: 0, longDeadlineMs: 8_000 });
  const stats = actions as unknown as { writtenFormPoolStats: () => { movedToLong?: number } };
  const heavy = normal.repeat(3);
  const before = stats.writtenFormPoolStats().movedToLong ?? 0;
  const alone = await request("heavy-alone", heavy);
  expect(alone.ok).toBe(true);
  expect(stats.writtenFormPoolStats().movedToLong ?? 0).toBe(before);
  let stop = false;
  const loops = ["a", "b"].map(async (user) => { while (!stop) await request(`long-attacker-${user}`, shapes["_a"]!); });
  await Bun.sleep(300);
  const served = await request("heavy-bystander", heavy);
  stop = true;
  await Promise.all(loops);
  expect({ ok: served.ok, code: served.code }).toEqual({ ok: true, code: undefined });
  // It waits for the attacker job on the long lane (3 s at most), then converts for about 1.4 s.
  expect(served.seconds).toBeLessThan(8);
}, 120_000);

test.serial("a large legitimate document that outruns probation is served ahead of two attackers looping on the long lane, and is not demoted like them", async () => {
  // The attackers' jobs die on the long lane at 3 s and each one's next job waits in the queue, gaining priority with its wait. The legitimate 80 KB document needs about 1.4 s, past probation.
  pool.configureWrittenFormPool({ probationMs: 300, timeoutBaseMs: 3_000, timeoutPerKbMs: 0, longDeadlineMs: 5_000, agingGraceMs: 300 });
  const dense = "**bold** [link](https://example.com/a) *it* `code` ~~gone~~ **b** [l](https://example.com/b)\n\n- **a** [x](https://example.com/c)\n- *b* `c`\n\n".repeat(700).slice(0, 80_000);
  let stop = false;
  const attackers = [0, 1].map((index) => (async () => { while (!stop) { await request(`looper-${index}`, shapes["_a"]!); await Bun.sleep(20); } })());
  await Bun.sleep(7_000);
  const served = await request("legit-dense", dense);
  stop = true;
  await Promise.all(attackers);
  expect({ ok: served.ok, code: served.code }).toEqual({ ok: true, code: undefined });
  // It waits for the attacker job on the long lane (3 s at most), then converts for about 1.4 s.
  expect(served.seconds).toBeLessThan(8);
}, 120_000);

test.serial("after its first timeout, a looping attacker holds the long lane for the base budget only, not the allowance for its size", async () => {
  // 190 KB of "_a": the budget is 1 s + 40 ms per KB, about 8.6 s, for the first job; the demoted caller's next jobs get the 1 s base.
  pool.configureWrittenFormPool({ probationMs: 300, timeoutBaseMs: 1_000, timeoutPerKbMs: 40, longDeadlineMs: 20_000 });
  const first = await request("budget-attacker", shapes["_a"]!);
  expect(first.code).toBe("input-too-complex");
  expect(first.seconds).toBeGreaterThan(5);
  const second = await request("budget-attacker", shapes["_a"]!);
  expect(second.code).toBe("input-too-complex");
  expect(second.seconds).toBeLessThan(3.5);
}, 120_000);
