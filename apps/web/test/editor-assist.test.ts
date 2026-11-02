import { expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { history, undo } from "@tiptap/pm/history";
import { createAssistSession, hasNonTextContent, insertBelow, replaceSelection, requestAssist, textToContent, type AssistView } from "../src/editor-assist";
import { AssistPreview } from "../src/assist-menu";

const schema = getSchema([StarterKit]);
const doc = () => schema.nodeFromJSON({ type: "doc", content: [
  { type: "paragraph", content: [{ type: "text", text: "Hello brave world" }] },
  { type: "paragraph", content: [{ type: "text", text: "Second" }] },
] });
const stateWith = (from: number, to: number) => {
  const base = EditorState.create({ doc: doc(), plugins: [history()] });
  return base.apply(base.tr.setSelection(TextSelection.create(base.doc, from, to)));
};
const text = (state: EditorState) => state.doc.textBetween(0, state.doc.content.size, "|");
const reply = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status });

test("requestAssist posts the task and returns the text, or a friendly error kind", async () => {
  let sent: { url: string; body: Record<string, unknown> } | null = null;
  const ok = await requestAssist({ workspaceId: "w1", task: "rephrase", text: "hi" }, async (url, init) => { sent = { url: String(url), body: JSON.parse(String(init?.body)) }; return new Response(JSON.stringify({ text: "hey" })); });
  expect(ok).toEqual({ text: "hey" });
  expect(sent!.url).toEndWith("/api/ai/assist");
  expect(sent!.body).toEqual({ workspaceId: "w1", task: "rephrase", text: "hi" });
  expect(await requestAssist({ workspaceId: "w1", task: "translate", text: "hi", targetLanguage: "Thai" }, reply(502, { error: "provider secret", code: "ai_failed" }))).toEqual({ error: "failed" });
  expect(await requestAssist({ workspaceId: "w1", task: "shorten", text: "hi" }, reply(429, { code: "rate_limited" }))).toEqual({ error: "rate_limited" });
  expect(await requestAssist({ workspaceId: "w1", task: "shorten", text: "hi" }, async () => { throw new Error("offline"); })).toEqual({ error: "failed" });
});

test("Replace swaps the selection and one undo restores it", () => {
  const state = stateWith(7, 12); // "brave"
  const next = state.apply(replaceSelection(state, 7, 12, "bold"));
  expect(text(next)).toBe("Hello bold world|Second");
  let undone = next;
  undo(next, (tr) => { undone = next.apply(tr); });
  expect(text(undone)).toBe("Hello brave world|Second");
});

test("Replace puts a multi-paragraph result in as separate paragraphs", () => {
  const state = stateWith(1, 18);
  const next = state.apply(replaceSelection(state, 1, 18, "One\n\n- a\n- b"));
  expect(next.doc.child(0).textContent).toBe("One");
  expect(next.doc.child(1).type.name).toBe("bulletList");
  expect(next.doc.lastChild!.textContent).toBe("Second");
});

test("Insert below keeps the original and adds the result after its block", () => {
  const state = stateWith(7, 12);
  const next = state.apply(insertBelow(state, 12, "Added"));
  expect(text(next)).toBe("Hello brave world|Added|Second");
});

test("textToContent maps paragraphs, line breaks and lists", () => {
  expect(textToContent("a\nb\n\n1. x\n2. y")).toEqual([
    { type: "paragraph", content: [{ type: "text", text: "a" }, { type: "hardBreak" }, { type: "text", text: "b" }] },
    { type: "orderedList", content: [
      { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "x" }] }] },
      { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "y" }] }] },
    ] },
  ]);
});

test("session goes loading to result, reruns with another task, and drops stale answers", async () => {
  const calls: string[] = [];
  const answers = new Map<string, (value: Response) => void>();
  const fetcher = (_url: unknown, init?: RequestInit) => new Promise<Response>((resolve) => { const body = JSON.parse(String(init?.body)); calls.push(body.task); answers.set(body.task, resolve); });
  const session = createAssistSession({ workspaceId: "w1", fetcher });
  const views: AssistView[] = [];
  session.subscribe((view) => views.push(view));
  expect(session.view()).toEqual({ status: "idle" });
  session.run("rephrase", "hello", { from: 1, to: 6 });
  expect(session.view()).toMatchObject({ status: "loading", task: "rephrase", range: { from: 1, to: 6 } });
  session.run("summarize", "hello", { from: 1, to: 6 }); // rerun on the same selection
  answers.get("rephrase")!(new Response(JSON.stringify({ text: "stale" })));
  await Bun.sleep(5);
  expect(session.view()).toMatchObject({ status: "loading", task: "summarize" });
  answers.get("summarize")!(new Response(JSON.stringify({ text: "short" })));
  await Bun.sleep(5);
  expect(session.view()).toMatchObject({ status: "result", task: "summarize", result: "short" });
  session.discard();
  expect(session.view()).toEqual({ status: "idle" });
  expect(calls).toEqual(["rephrase", "summarize"]);
});

test("session shows an error state and can retry", async () => {
  let fail = true;
  const session = createAssistSession({ workspaceId: "w1", fetcher: async () => fail ? new Response("{}", { status: 502 }) : new Response(JSON.stringify({ text: "ok" })) });
  session.run("expand", "x", { from: 1, to: 2 });
  await Bun.sleep(5);
  expect(session.view()).toMatchObject({ status: "error", error: "failed" });
  fail = false;
  session.run("expand", "x", { from: 1, to: 2 });
  await Bun.sleep(5);
  expect(session.view()).toMatchObject({ status: "result", result: "ok" });
});

const preview = (view: AssistView) => renderToStaticMarkup(React.createElement(AssistPreview, { view, onRun: () => {}, onReplace: () => {}, onInsertBelow: () => {}, onDiscard: () => {} }));

test("Assist preview renders loading, result with actions, and a friendly error", () => {
  const range = { from: 1, to: 2 };
  expect(preview({ status: "idle" })).toBe("");
  expect(preview({ status: "loading", task: "rephrase", range })).toContain('role="status"');
  const result = preview({ status: "result", task: "rephrase", range, result: "New text" });
  expect(result).toContain("New text");
  for (const label of ["Replace", "Insert below", "Discard"]) expect(result).toContain(label);
  const error = preview({ status: "error", task: "rephrase", range, error: "failed" });
  expect(error).toContain('role="alert"');
  expect(error).not.toContain("Replace");
  expect(error).toContain("Discard");
});

test("hasNonTextContent flags atoms such as images or mentions inside the range, not plain text or line breaks", () => {
  const withAtom = getSchema([StarterKit]);
  const plain = EditorState.create({ doc: doc() });
  expect(hasNonTextContent(plain.doc, 1, plain.doc.content.size)).toBe(false);
  const rule = withAtom.nodeFromJSON({ type: "doc", content: [
    { type: "paragraph", content: [{ type: "text", text: "a" }, { type: "hardBreak" }, { type: "text", text: "b" }] },
    { type: "horizontalRule" },
  ] });
  expect(hasNonTextContent(rule, 1, 4)).toBe(false);
  expect(hasNonTextContent(rule, 1, rule.content.size)).toBe(true);
});
