import { afterEach, expect, test } from "bun:test";
import * as actions from "../src";

// A shape list can always be evaded, so no input is trusted to be fast: every job gets a short probation on its own lane, and one that outruns it is aborted and
// waits on the single long lane instead. These shapes slip past the suspect pre-scan (a gap of 13 or more characters), so only probation protects the other lanes.
const pool = actions as unknown as {
  configureWrittenFormPool: (next: Record<string, number>) => void; resetWrittenFormPoolConfig: () => void; resetWrittenFormPoolHolds?: () => void;
  withWrittenFormKey: <T>(key: string, run: () => T) => T; isSuspect: (text: string) => boolean;
  writtenFormPoolStats: () => { movedToLong?: number; maxHoldMs?: Record<string, number> };
};
afterEach(() => { pool.resetWrittenFormPoolConfig(); });

const evasive: Record<string, string> = {
  "www. + 15 chars + _ (190 KB)": ("www." + "a".repeat(15) + "_").repeat(9_500),
  "_a (190 KB)": "_a".repeat(95_000),
  "www.a(13) (48 KB)": ("www." + "a".repeat(13)).repeat(2_800),
};
const bystanders = { "14 KB": "See www.example.com for the plan. ".repeat(400), "40 KB with a backtick": "Run `npm test` and see www.example.com now. ".repeat(900) };
const document = (text: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
type Outcome = { ok: boolean; code?: string; seconds: number };
const settle = async (run: () => Promise<unknown>): Promise<Outcome> => {
  const started = performance.now();
  try { await run(); return { ok: true, seconds: (performance.now() - started) / 1000 }; }
  catch (error) { return { ok: false, code: (error as { code?: string }).code, seconds: (performance.now() - started) / 1000 }; }
};
const request = (key: string, text: string) => pool.withWrittenFormKey(key, () => settle(() => actions.prepareRichTextGuarded(undefined, text, "body", "bodyMarkdown", {}, "verbatim")));

test("the evasive shapes really do slip past the suspect pre-scan", () => {
  for (const [name, text] of Object.entries(evasive)) expect({ name, suspect: pool.isSuspect(text) }).toEqual({ name, suspect: false });
});

// Probation is shortened so these tests are quick; one case per lane runs with the real 2 s ("real-time smoke").
const FAST_PROBATION_MS = 400;
// An attacker that outruns probation waits on the single long lane for its whole budget, so the budgets are short too.
const FAST = { probationMs: FAST_PROBATION_MS, timeoutBaseMs: 500, timeoutPerKbMs: 0, longDeadlineMs: 4_000 };
const holdLimit = (probationMs: number) => probationMs + 1_200;
for (const [shape, text] of Object.entries(evasive)) {
  for (const [bystander, body] of Object.entries(bystanders)) {
    const smoke = shape === Object.keys(evasive)[0] && bystander === Object.keys(bystanders)[0];
    test.serial(`two accounts x 3 requests of "${shape}": a ${bystander} bystander is served within its own deadline${smoke ? " (real-time smoke)" : ""}`, async () => {
      const probationMs = smoke ? 2_000 : FAST_PROBATION_MS;
      if (!smoke) pool.configureWrittenFormPool(FAST);
      pool.resetWrittenFormPoolHolds?.();
      const attackers = ["a", "b"].flatMap((user) => Array.from({ length: 3 }, () => request(`user:attacker-${user}`, text)));
      await Bun.sleep(150);
      const served = await request("user:bystander", body);
      expect({ ok: served.ok, code: served.code }).toEqual({ ok: true, code: undefined });
      expect(served.seconds).toBeLessThan(6);
      await Promise.all(attackers);
      // No ordinary or small worker was held longer than probation (plus the time to stop a thread).
      const holds = pool.writtenFormPoolStats().maxHoldMs ?? { ordinary: 99_999, small: 99_999 };
      expect(holds.ordinary).toBeLessThan(holdLimit(probationMs));
      expect(holds.small).toBeLessThan(holdLimit(probationMs));
    }, 180_000);
  }
}

const live = (page: string, user: string, text: string) => settle(() => actions.prepareRichTextGuarded(document(text), undefined, "content", "contentMarkdown", {}, "derived", {}, { inlineLimit: 0, lane: "live", page, user } as never));
const normalSave = "A live edit with a https://example.com link. ".repeat(300);

test.serial("six slow live saves from six pages and users do not delay a normal live save (real-time smoke)", async () => {
  pool.resetWrittenFormPoolHolds?.();
  const slow = Array.from({ length: 6 }, (_, index) => live(`page-slow-${index}`, `user-slow-${index}`, evasive["_a (190 KB)"]!));
  await Bun.sleep(150);
  const normal = await live("page-normal", "user-normal", normalSave);
  expect({ ok: normal.ok, code: normal.code }).toEqual({ ok: true, code: undefined });
  expect(normal.seconds).toBeLessThan(3);
  await Promise.all(slow);
  expect(pool.writtenFormPoolStats().maxHoldMs?.live ?? 99_999).toBeLessThan(3_200);
}, 180_000);

test.serial("one user saving six slow pages does not delay a normal live save", async () => {
  pool.configureWrittenFormPool(FAST);
  const slow = Array.from({ length: 6 }, (_, index) => live(`page-one-${index}`, "user-one", evasive["www. + 15 chars + _ (190 KB)"]!));
  await Bun.sleep(150);
  const normal = await live("page-normal-2", "user-normal-2", normalSave);
  expect({ ok: normal.ok, code: normal.code }).toEqual({ ok: true, code: undefined });
  expect(normal.seconds).toBeLessThan(3);
  await Promise.all(slow);
}, 180_000);

test.serial("a legitimate job that outruns probation moves to the long lane and completes within its scaled budget", async () => {
  pool.configureWrittenFormPool({ probationMs: 30, directLongBytes: 10 ** 9 });
  const before = pool.writtenFormPoolStats().movedToLong ?? 0;
  const line = "**bold** and `code` with [a link](https://example.test/x) and ~~strike~~ plus snake_case_word and f(x) - ";
  const content = Array.from({ length: 450 }, (_, index) => ({ type: "paragraph", content: [{ type: "text", text: `n${index} `, marks: [{ type: "bold" }] }, { type: "text", text: line.repeat(3) }] }));
  const prepared = await actions.prepareRichTextGuarded({ type: "doc", content }, undefined, "content", "contentMarkdown", {}, "derived");
  // The text holds a literal URL, so the normal tier fails verification and the link-safe tier writes it: `://` escaped, `_` after a letter left as it is.
  expect(prepared.markdown).toContain("snake_case_word");
  expect(prepared.markdown).toContain("https\\://example.test/x");
  expect(pool.writtenFormPoolStats().movedToLong ?? 0).toBeGreaterThan(before);
}, 60_000);
