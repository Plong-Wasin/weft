import { Extension } from "@tiptap/core";
import { Fragment, Slice, type Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { api } from "./api";

export const ASSIST_TASKS = ["rephrase", "fix_grammar", "summarize", "translate", "expand", "shorten"] as const;
export type AssistTask = (typeof ASSIST_TASKS)[number];
export type AssistErrorKind = "failed" | "rate_limited";
export type AssistRange = { from: number; to: number };
export type AssistView =
  | { status: "idle" }
  | { status: "loading"; task: AssistTask; range: AssistRange; targetLanguage?: string }
  | { status: "result"; task: AssistTask; range: AssistRange; targetLanguage?: string; result: string }
  | { status: "error"; task: AssistTask; range: AssistRange; targetLanguage?: string; error: AssistErrorKind };

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

/** Calls POST /api/ai/assist. Provider detail never reaches the UI: failures collapse to a kind the UI has a message for. */
export async function requestAssist(
  body: { workspaceId: string; task: AssistTask; text: string; targetLanguage?: string },
  fetcher: Fetcher = (input, init) => fetch(input, init),
): Promise<{ text: string } | { error: AssistErrorKind }> {
  try {
    const response = await fetcher(`${api}/api/ai/assist`, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (response.status === 429) return { error: "rate_limited" };
    if (!response.ok) return { error: "failed" };
    const data = await response.json().catch(() => null) as { text?: unknown } | null;
    return typeof data?.text === "string" && data.text.trim() ? { text: data.text } : { error: "failed" };
  } catch {
    return { error: "failed" };
  }
}

/** One Assist preview at a time. Rerunning supersedes an in-flight request, so a late answer never overwrites the newer one. */
export function createAssistSession({ workspaceId, fetcher }: { workspaceId: string; fetcher?: Fetcher }) {
  let view: AssistView = { status: "idle" };
  let generation = 0;
  const listeners = new Set<(view: AssistView) => void>();
  const set = (next: AssistView) => { view = next; for (const listener of listeners) listener(view); };
  return {
    view: () => view,
    subscribe(listener: (view: AssistView) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    run(task: AssistTask, text: string, range: AssistRange, targetLanguage?: string) {
      const mine = ++generation;
      set({ status: "loading", task, range, targetLanguage });
      void requestAssist({ workspaceId, task, text, ...(targetLanguage ? { targetLanguage } : {}) }, fetcher).then((outcome) => {
        if (mine !== generation) return;
        set("text" in outcome ? { status: "result", task, range, targetLanguage, result: outcome.text } : { status: "error", task, range, targetLanguage, error: outcome.error });
      });
    },
    discard() { generation++; set({ status: "idle" }); },
  };
}

type Json = { type: string; content?: Json[]; text?: string };
const inline = (line: string): Json[] => line ? [{ type: "text", text: line }] : [];
const paragraph = (lines: string[]): Json => ({ type: "paragraph", content: lines.flatMap((line, index) => index ? [{ type: "hardBreak" }, ...inline(line)] : inline(line)) });

/** Turns the plain-text answer into editor content: paragraphs, line breaks, and simple lists. No HTML from the server is trusted. */
export function textToContent(text: string): Json[] {
  return text.trim().split(/\n{2,}/).filter((block) => block.trim()).map((block) => {
    const lines = block.split("\n").map((line) => line.trimEnd());
    const list = (pattern: RegExp, type: string): Json | null => lines.every((line) => pattern.test(line))
      ? { type, content: lines.map((line) => ({ type: "listItem", content: [paragraph([line.replace(pattern, "")])] })) } : null;
    return list(/^\s*[-*•]\s+/, "bulletList") ?? list(/^\s*\d+[.)]\s+/, "orderedList") ?? paragraph(lines);
  });
}

function toNodes(state: EditorState, text: string): PMNode[] {
  return textToContent(text).map((json) => state.schema.nodeFromJSON(json));
}

/** Replace: an ordinary transaction, so one undo restores the selection. A single paragraph merges into the surrounding text. */
export function replaceSelection(state: EditorState, from: number, to: number, text: string): Transaction {
  const nodes = toNodes(state, text);
  const single = nodes.length === 1 && nodes[0]!.type.name === "paragraph";
  return state.tr.replaceRange(from, to, new Slice(Fragment.from(nodes), single ? 1 : 0, single ? 1 : 0)).scrollIntoView();
}

/** Insert below: the original stays; the result lands after the top-level block holding the selection end. */
export function insertBelow(state: EditorState, to: number, text: string): Transaction {
  const $to = state.doc.resolve(to);
  const at = $to.depth > 0 ? $to.after(1) : to;
  return state.tr.insert(at, Fragment.from(toNodes(state, text))).scrollIntoView();
}

const highlightKey = new PluginKey<{ range: AssistRange | null }>("aiAssistHighlight");

/** Shareable AI assist extension: keeps the selection visibly marked while the Assist preview is open, mapping it through edits. */
export const AiAssist = Extension.create({
  name: "aiAssist",
  addProseMirrorPlugins() {
    return [new Plugin({
      key: highlightKey,
      state: {
        init: () => ({ range: null as AssistRange | null }),
        apply(tr, value) {
          const meta = tr.getMeta(highlightKey) as { range: AssistRange | null } | undefined;
          if (meta) return meta;
          return value.range ? { range: { from: tr.mapping.map(value.range.from), to: tr.mapping.map(value.range.to, -1) } } : value;
        },
      },
      props: {
        decorations(state) {
          const range = highlightKey.getState(state)?.range;
          return range && range.to > range.from ? DecorationSet.create(state.doc, [Decoration.inline(range.from, range.to, { class: "ai-assist-selection" })]) : null;
        },
      },
    })];
  },
});

export function markAssistRange(tr: Transaction, range: AssistRange | null): Transaction {
  return tr.setMeta(highlightKey, { range });
}

export function getAssistRange(state: EditorState): AssistRange | null {
  return highlightKey.getState(state)?.range ?? null;
}
