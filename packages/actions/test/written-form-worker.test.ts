import { expect, test } from "bun:test";
import { prepareRichText, prepareRichTextGuarded, richTextTextContent, writtenFormOf, writtenFormPoolStats } from "../src";
import { markdownToDocWithWarnings } from "../src/markdown-doc";
import { pathologicalDocumentTexts, pathologicalTexts, tableDocument } from "./support/pathological";

const attempt = async (run: () => Promise<unknown>) => {
  const started = performance.now();
  let outcome = "accepted";
  try { await run(); } catch (error) { outcome = (error as { code?: string }).code ?? String((error as Error).message); }
  return { outcome, seconds: (performance.now() - started) / 1000 };
};
const paragraph = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });

test.serial("every pathological text finishes within the timeout plus margin and the slow ones are refused as input-too-complex", async () => {
  const slow = new Set(["www.a_ x4000 (24 KB, unspaced)", "www.a_ x8000 (48 KB, unspaced)", "```\\\\ x10000 (40 KB)", "=\\\\\\n x13333 (40 KB)", "[^1]:1.  x5000 (40 KB)"]);
  for (const [name, text] of Object.entries(pathologicalTexts)) {
    const { outcome, seconds } = await attempt(() => prepareRichTextGuarded(undefined, text, "body", "bodyMarkdown", {}, "verbatim"));
    expect({ name, within: seconds < 4.5 }).toEqual({ name, within: true });
    if (slow.has(name)) expect({ name, outcome: ["input-too-complex", "nesting-too-deep"].includes(outcome) }).toEqual({ name, outcome: true });
  }
}, 60_000);

test.serial("pathological text inside an editor document is refused within the timeout (the round trip runs on the worker)", async () => {
  for (const [name, text] of Object.entries(pathologicalDocumentTexts)) {
    const { seconds } = await attempt(() => prepareRichTextGuarded({ type: "doc", content: [paragraph(text)] }, undefined, "content", "contentMarkdown", {}, "derived"));
    expect({ name, within: seconds < 4.5 }).toEqual({ name, within: true });
  }
}, 60_000);

test.serial("the event loop stays responsive while a pathological input converts", async () => {
  let worst = 0, last = performance.now();
  const timer = setInterval(() => { const now = performance.now(); worst = Math.max(worst, now - last - 10); last = now; }, 10);
  const trivial = (async () => { await Bun.sleep(300); return "trivial request done"; })();
  const slow = attempt(() => prepareRichTextGuarded(undefined, "www.a_".repeat(4_000), "body", "bodyMarkdown", {}, "verbatim"));
  expect(await trivial).toBe("trivial request done");
  await slow;
  clearInterval(timer);
  expect(worst).toBeLessThan(250);
}, 30_000);

test.serial("after a timeout the worker is respawned and the next conversion works", async () => {
  const before = writtenFormPoolStats().respawns;
  await attempt(() => prepareRichTextGuarded(undefined, "www.a_".repeat(8_000), "body", "bodyMarkdown", {}, "verbatim"));
  expect(writtenFormPoolStats().respawns).toBeGreaterThan(before);
  const big = Array.from({ length: 400 }, (_, i) => `Normal paragraph ${i} with **bold** words and a [link](https://example.test/${i}).`).join("\n\n");
  const result = await prepareRichTextGuarded(undefined, big, "body", "bodyMarkdown", {}, "derived");
  expect(big.length).toBeGreaterThan(8 * 1024);
  expect(result.markdown).toContain("Normal paragraph 399");
}, 30_000);

test.serial("normal documents give the same answer in-process and on the worker", async () => {
  const markdown = "# Title\n\nSome **bold** text with [[ABC-1]] and a list:\n\n- one\n- two\n";
  const inline = await prepareRichTextGuarded(undefined, markdown, "body", "bodyMarkdown", {}, "derived");
  const worker = await prepareRichTextGuarded(undefined, markdown, "body", "bodyMarkdown", {}, "derived", {}, { inlineLimit: 0 });
  expect(worker).toEqual(inline);
  expect(worker).toEqual(prepareRichText(undefined, markdown, "body", "bodyMarkdown", {}, "derived"));
});

test.serial("a table over the row or cell cap is refused with a plain message", async () => {
  await expect(prepareRichTextGuarded(tableDocument(12_000), undefined, "content", "contentMarkdown", {}, "derived")).rejects.toThrow("This table is too large to save. Split it into smaller tables.");
  const rows = Array.from({ length: 12_000 }, () => "| a | b |").join("\n");
  await expect(prepareRichTextGuarded(undefined, `| h | h |\n| - | - |\n${rows}`, "body", "bodyMarkdown", {}, "derived")).rejects.toThrow("too large");
  expect((await prepareRichTextGuarded(tableDocument(50), undefined, "content", "contentMarkdown", {}, "derived")).markdown).toContain("| c | c |");
});

test.serial("writtenFormOf serves a verified Written form and degrades to escaped text on a timeout", async () => {
  const verified = { type: "doc", content: [paragraph("Use <https://example.com> here")] };
  expect(richTextTextContent(markdownToDocWithWarnings(await writtenFormOf(verified), { trustedSource: true }).document)).toEqual(richTextTextContent(verified));
  const hostile = { type: "doc", content: [paragraph("www.a_".repeat(8_000))] };
  const started = performance.now();
  const form = await writtenFormOf(hostile, { timeoutMs: 500 });
  expect(performance.now() - started).toBeLessThan(2_500);
  expect(form.length).toBeGreaterThan(0);
}, 30_000);
