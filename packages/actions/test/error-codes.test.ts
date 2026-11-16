import { afterEach, expect, test } from "bun:test";
import * as actions from "../src";

// The documented limit codes survive every path, and a lone slow input is a plain 400 `input-too-complex`, never a retryable 429.
const pool = actions as unknown as { configureWrittenFormPool: (next: Record<string, number>) => void; resetWrittenFormPoolConfig: () => void };
afterEach(() => pool.resetWrittenFormPoolConfig());
const refuse = (markdown: string) => actions.prepareRichTextGuarded(undefined, markdown, "body", "bodyMarkdown", {}, "verbatim").then(() => null, (error) => error as { status?: number; code?: string; message: string; retryAfter?: number });

for (const [name, markdown] of Object.entries({ "*_ x90000": "*_".repeat(90_000), "[a]( x30000": "[a](".repeat(30_000) })) {
  test(`${name} is refused as input-too-complex (400), with its code, on the guarded and the synchronous path`, async () => {
    const guarded = await refuse(markdown);
    expect({ status: guarded?.status, code: guarded?.code }).toEqual({ status: 400, code: "input-too-complex" });
    const { prepareRichText } = await import("../src/rich-markdown");
    let sync: { status?: number; code?: string } = {};
    try { prepareRichText(undefined, markdown, "body", "bodyMarkdown", {}, "verbatim"); } catch (error) { sync = error as typeof sync; }
    expect({ status: sync.status, code: sync.code }).toEqual({ status: 400, code: "input-too-complex" });
  });
}

test.serial('"_a" x95000 sent alone answers input-too-complex (400), not busy (429) with a Retry-After', async () => {
  // Its budget (3 s) is longer than the request deadline (2 s): it must still be allowed to use it, because nothing else is waiting.
  pool.configureWrittenFormPool({ requestDeadlineMs: 2_000, timeoutBaseMs: 3_000, timeoutPerKbMs: 0 });
  const error = await refuse("_a".repeat(95_000));
  expect({ status: error?.status, code: error?.code, retryAfter: error?.retryAfter }).toEqual({ status: 400, code: "input-too-complex", retryAfter: undefined });
}, 60_000);

test("20,000 bare [ are refused with a message about brackets, not about references", async () => {
  const error = await refuse("[".repeat(20_000));
  expect({ status: error?.status, code: error?.code }).toEqual({ status: 400, code: "input-too-complex" });
  expect(error?.message).toContain("too many [[ brackets");
  expect(error?.message).not.toContain("[[references]]");
});
