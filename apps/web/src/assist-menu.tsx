import React from "react";
import type { Editor } from "@tiptap/react";
import { translate, type MessageKey } from "@weft/shared";
import { ASSIST_TASKS, createAssistSession, insertBelow, markAssistRange, replaceSelection, getAssistRange, type AssistTask, type AssistView } from "./editor-assist";

const buttonClass = "secondary !px-2 !py-1 !text-12";

/** The six tasks; Translate asks for a target language first. Used by the menu and, to rerun, by the preview. */
function TaskPicker({ current, initialLanguage, onRun }: { current?: AssistTask; initialLanguage?: string; onRun: (task: AssistTask, targetLanguage?: string) => void }) {
  const [asking, setAsking] = React.useState(current === "translate");
  const [language, setLanguage] = React.useState(initialLanguage ?? "");
  const label = (task: AssistTask) => translate(`assist.task.${task}` as MessageKey);
  return <div className="grid gap-1.5">
    <div className="flex flex-wrap gap-1" role="group" aria-label={translate("assist.menu")}>
      {ASSIST_TASKS.map((task) => <button key={task} type="button" className={buttonClass} aria-pressed={task === current} onClick={() => task === "translate" ? setAsking(true) : onRun(task)}>{label(task)}</button>)}
    </div>
    {asking && <form className="flex gap-1" onSubmit={(event) => { event.preventDefault(); if (language.trim()) onRun("translate", language.trim()); }}>
      <input value={language} onChange={(event) => setLanguage(event.target.value)} maxLength={100} aria-label={translate("assist.targetLanguage")} placeholder={translate("assist.targetLanguage.placeholder")} className="!py-1 !text-12" />
      <button type="submit" className={buttonClass} disabled={!language.trim()}>{translate("assist.translateRun")}</button>
    </form>}
  </div>;
}

/** Assist preview: loading, the result, or a friendly error. The document is untouched until Replace or Insert below. */
export function AssistPreview({ view, onRun, onReplace, onInsertBelow, onDiscard }: {
  view: AssistView; onRun: (task: AssistTask, targetLanguage?: string) => void; onReplace: () => void; onInsertBelow: () => void; onDiscard: () => void;
}) {
  if (view.status === "idle") return null;
  return <section aria-label={translate("assist.preview")} className="grid w-96 max-w-full gap-2 rounded-md border border-strong bg-surface-1 p-2 shadow-lg">
    {view.status === "loading" && <p role="status" className="m-0 text-13 text-secondary">{translate("assist.loading")}</p>}
    {view.status === "error" && <p role="alert" className="m-0 text-13 text-danger-primary">{translate(`assist.error.${view.error}` as MessageKey)}</p>}
    {view.status === "result" && <p data-testid="assist-result" className="m-0 max-h-60 overflow-auto whitespace-pre-wrap text-13 text-primary">{view.result}</p>}
    <div className="flex flex-wrap gap-1">
      {view.status === "result" && <button type="button" onClick={onReplace}>{translate("assist.replace")}</button>}
      {view.status === "result" && <button type="button" className="secondary" onClick={onInsertBelow}>{translate("assist.insertBelow")}</button>}
      <button type="button" className="secondary" onClick={onDiscard}>{translate("assist.discard")}</button>
    </div>
    <details className="text-12 text-secondary">
      <summary>{translate("assist.rerun")}</summary>
      <TaskPicker current={view.task} initialLanguage={view.targetLanguage} onRun={onRun} />
    </details>
  </section>;
}

function useSelectionKey(editor: Editor): string {
  return React.useSyncExternalStore(
    React.useCallback((notify: () => void) => { editor.on("transaction", notify); return () => { editor.off("transaction", notify); }; }, [editor]),
    () => `${editor.state.selection.from}:${editor.state.selection.to}:${editor.isEditable}`,
  );
}

/** AI assist bubble menu for any Tiptap editor that has the `AiAssist` extension. Render it inside a `relative` wrapper around the editor. */
export function AssistMenu({ editor, workspaceId }: { editor: Editor | null; workspaceId: string }) {
  if (!editor) return null;
  return <AssistMenuFor editor={editor} workspaceId={workspaceId} />;
}

function AssistMenuFor({ editor, workspaceId }: { editor: Editor; workspaceId: string }) {
  const session = React.useMemo(() => createAssistSession({ workspaceId }), [workspaceId]);
  const view = React.useSyncExternalStore(session.subscribe, session.view);
  const key = useSelectionKey(editor);
  const [from, to, editable] = key.split(":");
  const hasSelection = editable === "true" && Number(from) !== Number(to);
  const root = React.useRef<HTMLDivElement>(null);
  const [place, setPlace] = React.useState({ top: 0, left: 0 });

  React.useLayoutEffect(() => {
    const parent = root.current?.offsetParent;
    if (!parent || !(hasSelection || view.status !== "idle")) return;
    const target = view.status === "idle" ? Number(to) : view.range.to;
    try {
      const box = editor.view.coordsAtPos(target);
      const bounds = parent.getBoundingClientRect();
      setPlace({ top: box.bottom - bounds.top + 6, left: Math.max(0, Math.min(box.left - bounds.left, bounds.width - 200)) });
    } catch { /* position unavailable: keep the last one */ }
  }, [editor, hasSelection, to, view]);

  React.useEffect(() => () => { session.discard(); }, [session]);

  const clear = () => { editor.view.dispatch(markAssistRange(editor.state.tr, null)); session.discard(); };
  const run = (task: AssistTask, targetLanguage?: string) => {
    const range = view.status === "idle" ? { from: editor.state.selection.from, to: editor.state.selection.to } : getAssistRange(editor.state) ?? view.range;
    const text = editor.state.doc.textBetween(range.from, range.to, "\n\n");
    if (!text.trim()) return;
    editor.view.dispatch(markAssistRange(editor.state.tr, range));
    session.run(task, text, range, targetLanguage);
  };
  const accept = (apply: typeof replaceSelection | typeof insertBelow) => {
    if (view.status !== "result") return;
    const range = getAssistRange(editor.state) ?? view.range;
    const tr = apply === insertBelow ? insertBelow(editor.state, range.to, view.result) : replaceSelection(editor.state, range.from, range.to, view.result);
    editor.view.dispatch(markAssistRange(tr, null));
    session.discard();
    editor.view.focus();
  };

  return <div ref={root} className="absolute z-20" style={{ top: place.top, left: place.left }} onMouseDown={(event) => { if (!(event.target instanceof HTMLInputElement)) event.preventDefault(); }}>
    {view.status !== "idle"
      ? <AssistPreview view={view} onRun={run} onReplace={() => accept(replaceSelection)} onInsertBelow={() => accept(insertBelow)} onDiscard={clear} />
      : hasSelection && <div role="toolbar" aria-label={translate("assist.menu")} className="rounded-md border border-strong bg-surface-1 p-1.5 shadow-lg"><TaskPicker onRun={run} /></div>}
  </div>;
}
