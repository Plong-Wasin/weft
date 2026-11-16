import { expect, test } from "bun:test";
import * as actions from "../src";
import { documentTableTooLarge } from "../src/written-form-guard";
import { tableDocument } from "./support/pathological";

const api = actions as unknown as { scaledTimeoutMs?: (size: number, profile?: "request" | "backfill") => number; runInWorker: (op: string, args: unknown[], run?: unknown) => Promise<unknown> };
const failure = async (run: () => Promise<unknown>) => { try { await run(); return null; } catch (error) { return error as { status?: number; code?: string; message: string }; } };
const paragraph = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });

test("the timeout grows with the size of the input: 5 s + 60 ms per KB for requests (about 17 s at 200 KB), 20 s + 50 ms per KB for the backfill", () => {
  expect(api.scaledTimeoutMs?.(0)).toBe(5_000);
  expect(api.scaledTimeoutMs?.(100 * 1024)).toBe(5_000 + 60 * 100);
  expect(api.scaledTimeoutMs?.(200 * 1024)).toBe(5_000 + 60 * 200);
  expect(api.scaledTimeoutMs?.(5_000 * 1024)).toBe(30_000);
  expect(api.scaledTimeoutMs?.(0, "backfill")).toBe(20_000);
  expect(api.scaledTimeoutMs?.(200 * 1024, "backfill")).toBe(20_000 + 50 * 200);
});

test.serial("a document near the cap is converted within the budget its size earns", async () => {
  const line = "snake_case_name and other_words (with) [brackets] ".repeat(2);
  const document = { type: "doc", content: Array.from({ length: Math.floor(120_000 / line.length) }, () => paragraph(line)) };
  const started = performance.now();
  const prepared = await actions.prepareRichTextGuarded(document, undefined, "content", "contentMarkdown", {}, "derived");
  const elapsed = performance.now() - started;
  expect(prepared.markdown.length).toBeGreaterThan(120_000);
  expect(elapsed).toBeLessThan(api.scaledTimeoutMs?.(JSON.stringify(document).length) ?? 0);
}, 30_000);

test.serial("a worker that cannot take the job answers 503 converter-unavailable, not a stack trace", async () => {
  const unclonable = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "x".repeat(3_000), boom: () => 1 }] }] };
  const error = await failure(() => actions.prepareRichTextGuarded(unclonable, undefined, "content", "contentMarkdown", {}, "derived"));
  expect({ status: error?.status, code: error?.code }).toEqual({ status: 503, code: "converter-unavailable" });
  expect(error?.message).not.toMatch(/clone|DataCloneError|worker/i);
});

test.serial("an unknown internal error is 500 with a generic message; a validation error stays 400", async () => {
  const internal = await failure(() => api.runInWorker("parse", [123, {}]));
  expect({ status: internal?.status, code: internal?.code }).toEqual({ status: 500, code: "internal-error" });
  expect(internal?.message).not.toMatch(/TypeError|undefined|not a function|123/);
  const refused = await failure(() => actions.prepareRichTextGuarded(undefined, "x".repeat(200_001), "body", "bodyMarkdown", {}, "verbatim"));
  expect({ status: refused?.status, code: refused?.code }).toEqual({ status: 400, code: "input-too-long" });
});

test("a document nested 5,000 levels deep is refused as nesting-too-deep before anything is serialised", async () => {
  let node: Record<string, unknown> = { type: "paragraph", content: [{ type: "text", text: "deep" }] };
  for (let depth = 0; depth < 5_000; depth++) node = { type: "blockquote", content: [node] };
  const started = performance.now();
  const error = await failure(() => actions.prepareRichTextGuarded({ type: "doc", content: [node] }, undefined, "content", "contentMarkdown", {}, "derived"));
  expect(error?.code).toBe("nesting-too-deep");
  expect(performance.now() - started).toBeLessThan(150);
  let huge: Record<string, unknown> = { type: "paragraph" };
  for (let depth = 0; depth < 200_000; depth++) huge = { type: "blockquote", content: [huge] };
  expect((await failure(() => actions.prepareRichTextGuarded({ type: "doc", content: [huge] }, undefined, "content", "contentMarkdown", {}, "derived")))?.code).toBe("nesting-too-deep");
});

test("table cells are counted per table and in total", () => {
  expect(documentTableTooLarge(tableDocument(5_000, 4))).toBe(false);
  expect(documentTableTooLarge(tableDocument(5_001, 4))).toBe(true);
  const two = { type: "doc", content: [tableDocument(3_000, 4).content[0], tableDocument(3_000, 4).content[0]] };
  expect(documentTableTooLarge(two)).toBe(true);
});

test.serial("a table at the cell cap converts with a bounded memory growth", async () => {
  const before = process.memoryUsage().rss;
  const prepared = await actions.prepareRichTextGuarded(tableDocument(5_000, 4), undefined, "content", "contentMarkdown", {}, "derived");
  expect(prepared.markdown).toContain("| c | c | c | c |");
  const growthMb = (process.memoryUsage().rss - before) / 1_048_576;
  console.log(`RSS growth for a 20,000-cell table: ${growthMb.toFixed(0)} MB`);
  expect(growthMb).toBeLessThan(500);
}, 30_000);

const denseDocument = (kb: number) => {
  const line = "**bold** and `code` with [a link](https://example.test/x) and ~~strike~~ plus snake_case_word and f(x) - ";
  const content: unknown[] = [];
  let size = 0;
  for (let index = 0; size < kb * 1024; index++) {
    const block = { type: "paragraph", content: [{ type: "text", text: `n${index} `, marks: [{ type: "bold" }] }, { type: "text", text: line, marks: [{ type: "code" }] }, { type: "text", text: "link", marks: [{ type: "link", attrs: { href: `https://example.test/${index}` } }] }, { type: "text", text: " tail ~strike~ & more_text " }] };
    content.push(block); size += JSON.stringify(block).length * 0.45;
  }
  return { type: "doc", content };
};

test.serial("a dense 195 KB document is accepted while a busy loop shares the core, and a pathological input is still refused within its bound", async () => {
  const taskset = Bun.which("taskset");
  if (!taskset) return;
  const cores = Number((await Bun.$`nproc`.text()).trim());
  const core = String(Math.max(cores - 1, 0));
  const busy = Bun.spawn([taskset, "-c", core, process.execPath, "-e", "for(;;){}"], { stdout: "ignore", stderr: "ignore" });
  await Bun.sleep(300);
  await Bun.$`${taskset} -a -pc ${core} ${process.pid}`.quiet();
  try {
    const document = denseDocument(180);
    // Probation is short here, so the dense document is moved to the long lane while the core is shared, and must still finish within its scaled budget.
    (actions as unknown as { configureWrittenFormPool: (next: Record<string, number>) => void }).configureWrittenFormPool({ probationMs: 100, directLongBytes: 10 ** 9 });
    const movedBefore = (actions.writtenFormPoolStats() as { movedToLong?: number }).movedToLong ?? 0;
    const started = performance.now();
    const prepared = await actions.prepareRichTextGuarded(document, undefined, "content", "contentMarkdown", {}, "derived");
    const seconds = (performance.now() - started) / 1000;
    console.log(`dense ${prepared.markdown.length} char document on a shared core: ${seconds.toFixed(2)} s`);
    expect(prepared.markdown.length).toBeGreaterThan(190_000);
    expect((actions.writtenFormPoolStats() as { movedToLong?: number }).movedToLong ?? 0).toBeGreaterThan(movedBefore);
    const budget = (api.scaledTimeoutMs?.(JSON.stringify(document).length) ?? 0) / 1000;
    expect(seconds).toBeLessThan(budget / 3);
    const pathological = performance.now();
    const refused = await failure(() => actions.prepareRichTextGuarded(undefined, "www.a_".repeat(8_000), "body", "bodyMarkdown", {}, "verbatim"));
    expect(refused?.code === "input-too-complex" || refused?.code === "busy").toBe(true);
    expect((performance.now() - pathological) / 1000).toBeLessThan(4.5);
  } finally {
    (actions as unknown as { resetWrittenFormPoolConfig: () => void }).resetWrittenFormPoolConfig();
    await Bun.$`${taskset} -a -pc 0-${cores - 1} ${process.pid}`.quiet();
    busy.kill();
  }
}, 60_000);

test("the pool reads its limits from WEFT_WRITTEN_FORM_* variables, rejects invalid values, and every deployment file passes them through", async () => {
  const { poolConfigFromEnv } = actions as unknown as { poolConfigFromEnv?: (env: Record<string, string | undefined>) => Record<string, number> };
  expect(poolConfigFromEnv?.({})).toEqual({});
  expect(poolConfigFromEnv?.({ WEFT_WRITTEN_FORM_WORKERS: "4", WEFT_WRITTEN_FORM_QUEUE: "64", WEFT_WRITTEN_FORM_TIMEOUT_BASE_MS: "8000", WEFT_WRITTEN_FORM_TIMEOUT_PER_KB_MS: "80" })).toEqual({ requestWorkers: 4, queueLimit: 64, timeoutBaseMs: 8000, timeoutPerKbMs: 80 });
  for (const [name, value] of [["WEFT_WRITTEN_FORM_WORKERS", "0"], ["WEFT_WRITTEN_FORM_WORKERS", "9"], ["WEFT_WRITTEN_FORM_WORKERS", "two"], ["WEFT_WRITTEN_FORM_QUEUE", "-1"], ["WEFT_WRITTEN_FORM_TIMEOUT_BASE_MS", "100"], ["WEFT_WRITTEN_FORM_TIMEOUT_PER_KB_MS", "1.5"]] as const) {
    expect(() => poolConfigFromEnv?.({ [name]: value }), `${name}=${value}`).toThrow(name);
  }
  const root = new URL("../../..", import.meta.url).pathname;
  for (const file of ["compose.yaml", "docker-compose.dokploy.yml", ".env.example", "docs/production.md"]) {
    const text = await Bun.file(`${root}/${file}`).text();
    for (const name of ["WEFT_WRITTEN_FORM_WORKERS", "WEFT_WRITTEN_FORM_QUEUE", "WEFT_WRITTEN_FORM_TIMEOUT_BASE_MS", "WEFT_WRITTEN_FORM_TIMEOUT_PER_KB_MS"]) expect(text, `${file} lacks ${name}`).toContain(name);
  }
});
