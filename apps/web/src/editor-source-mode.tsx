import React from "react";
import { CircleAlert, FileText } from "lucide-react";
import type { Editor } from "@tiptap/react";
import { translate } from "@weft/shared";
import { markdownToDocWithWarnings } from "../../../packages/actions/src/markdown-doc";
import { richTextMarkdown } from "../../../packages/actions/src/written-form";
import { normalizeAssetImages } from "../../../packages/actions/src/wiki-yjs";

/** Finds legacy formatting that the Written form cannot express before the editor schema removes it. */
export function editorLimitWarnings(value: unknown): string[] {
  const found = new Set<string>();
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const current = node as { attrs?: Record<string, unknown>; content?: unknown[] };
    if (current.attrs?.textAlign) found.add("alignment");
    if (current.attrs?.backgroundColor) found.add("cellBackground");
    current.content?.forEach(visit);
  };
  visit(value);
  return [...found];
}

/** The ghost icon switch in an editor toolbar: pressed while the Markdown (Written form) text is shown. */
export function SourceModeButton({ active, onClick }: { active: boolean; onClick: () => void }) {
  return <button type="button" className="editor-tool" aria-label={translate("editor.sourceMode")} aria-pressed={active} title={translate(active ? "editor.visualMode" : "editor.sourceMode")} onMouseDown={(event) => event.preventDefault()} onClick={onClick}>
    <FileText aria-hidden size={14} />
  </button>;
}

/** Toggle an existing editor between its visual document and the exact Written form text. The caller renders the switch (SourceModeButton) and flips the mode through `toggleRef`; `onModeChange` reports the mode back. */
export function EditorSourceMode({ editor, initialWarnings = [], onSourceDraftChange, toggleRef, onModeChange }: { editor: Editor | null; initialWarnings?: string[]; onSourceDraftChange?: (hasDraft: boolean) => void; toggleRef?: React.MutableRefObject<(() => void) | null>; onModeChange?: (active: boolean) => void }) {
  const [source, setSource] = React.useState(false);
  const [text, setText] = React.useState("");
  const [warnings, setWarnings] = React.useState<string[]>([]);
  const [sourceLoss, setSourceLoss] = React.useState(false);
  const draft = React.useRef<string | null>(null);
  const sourceRef = React.useRef(false);
  const settingContent = React.useRef(false);
  React.useEffect(() => { setWarnings(initialWarnings); }, [initialWarnings.join(",")]);
  React.useEffect(() => {
    if (!editor) return;
    const clearDraftOnVisualEdit = ({ transaction }: { transaction: { docChanged: boolean } }) => {
      if (transaction.docChanged && !sourceRef.current && !settingContent.current) draft.current = null;
    };
    editor.on("transaction", clearDraftOnVisualEdit);
    return () => { editor.off("transaction", clearDraftOnVisualEdit); };
  }, [editor]);
  const showSource = (active: boolean) => {
    sourceRef.current = active;
    const surface = editor?.view.dom.closest("[data-testid='comment-editor'], [data-testid='description-editor'], [data-testid='wiki-editor']");
    surface?.toggleAttribute("data-source-mode", active);
    surface?.closest("[data-testid='wiki-editor-shell']")?.toggleAttribute("data-source-mode", active);
    setSource(active);
    onModeChange?.(active);
  };

  const toggle = () => {
    if (!editor) return;
    if (!source) {
      const serialized = richTextMarkdown(editor.getJSON());
      const next = draft.current ?? serialized.markdown;
      draft.current = next;
      setText(next);
      setSourceLoss(serialized.markdownWarnings.length > 0);
      setWarnings([]);
      sourceRef.current = true;
      showSource(true);
      return;
    }
    const converted = markdownToDocWithWarnings(text);
    const messages: Record<string, Parameters<typeof translate>[0]> = {
        "unsupported-html": "editor.warning.unsupportedHtml", "external-image": "editor.warning.externalImage",
        "unsafe-link": "editor.warning.unsafeLink", "unresolved-reference": "editor.warning.unresolvedReference",
        "irregular-table": "editor.warning.irregularTable", "deep-heading": "editor.warning.deepHeading",
        "unsupported-callout-metadata": "editor.warning.unsupportedCallout", "unsupported-markdown": "editor.warning.unsupportedContent",
        "input-too-complex": "editor.warning.inputTooComplex", "nesting-too-deep": "editor.warning.nestingTooDeep",
      };
    const fatalWarnings = converted.warningDetails.filter(({ code }) => ["input-too-complex", "input-too-long", "nesting-too-deep"].includes(code));
    if (fatalWarnings.length) {
      setWarnings(fatalWarnings.map(({ code }) => translate(messages[code] ?? "editor.warning.unsupportedContent")));
      return;
    }
    const appliedWarnings = [
      ...converted.warningDetails.map(({ code }) => translate(messages[code] ?? "editor.warning.unsupportedContent")),
      ...(sourceLoss ? [translate("editor.sourceLoss")] : []),
    ];
    settingContent.current = true;
    editor.commands.setContent(normalizeAssetImages(converted.document));
    settingContent.current = false;
    draft.current = text;
    sourceRef.current = false;
    setWarnings(appliedWarnings);
    setSourceLoss(false);
    showSource(false);
  };

  React.useEffect(() => {
    if (toggleRef) toggleRef.current = toggle;
  });
  React.useEffect(() => () => { if (toggleRef) toggleRef.current = null; }, [toggleRef]);

  return <div className="grid w-full min-w-0 max-w-full gap-2" data-testid="editor-source-mode">
    {source && <textarea aria-label={translate("editor.sourceText")} data-testid="editor-source-text" rows={Math.min(30, Math.max(6, text.split("\n").length + 1))} className="editor-source-text min-h-40 w-full min-w-0 max-w-full resize-y rounded-md border border-subtle bg-surface-1 p-3 font-mono text-13 text-primary" value={text} onChange={(event) => { draft.current = event.target.value; setText(event.target.value); setWarnings([]); onSourceDraftChange?.(true); }} />}
    {source && <p className="m-0 text-12 text-secondary">{translate("editor.sourceReferenceHelp")}</p>}
    {initialWarnings.includes("alignment") && <p role="status" className="m-0 text-13 text-warning-primary">{translate("editor.removedAlignment")}</p>}
    {initialWarnings.includes("cellBackground") && <p role="status" className="m-0 text-13 text-warning-primary">{translate("editor.removedCellBackground")}</p>}
    {sourceLoss && <div role="status" className="flex min-w-0 items-start gap-2 rounded-r-md border-l-4 border-danger-strong bg-danger-subtle px-3 py-2 text-13 text-danger-text"><CircleAlert aria-hidden size={16} className="mt-0.5 shrink-0" /><p className="m-0 min-w-0">{translate("editor.sourceLoss")}</p></div>}
    {warnings.length > 0 && <div role="alert" className="flex min-w-0 items-start gap-2 rounded-r-md border-l-4 border-warning-strong bg-warning-subtle px-3 py-2 text-13 text-warning-text"><CircleAlert aria-hidden size={16} className="mt-0.5 shrink-0" /><p className="m-0 min-w-0">{warnings.join(" ")}</p></div>}
  </div>;
}
