import React from "react";
import { Bold, Code, ImagePlus, Italic, List, ListChecks, ListOrdered, Quote, Strikethrough, Table2, Underline } from "lucide-react";
import type { Editor } from "@tiptap/react";
import { translate } from "@weft/shared";
import { LinkButton } from "./link-button";
import { SourceModeButton } from "./editor-source-mode";
import { withShortcut } from "./shortcuts";

/** One slim row of icon buttons shared by the Work item description and the comment composer. Each button names itself, shows its shortcut in the tooltip and reports its active state. */
export function EditorToolbar({ editor, label, testId, onImage, source, end }: { editor: Editor | null; label: string; testId: string; onImage: () => void; source?: { active: boolean; onToggle: () => void }; end?: React.ReactNode }) {
  const [, refresh] = React.useReducer((n: number) => n + 1, 0);
  React.useEffect(() => {
    if (!editor) return;
    editor.on("transaction", refresh);
    return () => { editor.off("transaction", refresh); };
  }, [editor]);
  const run = (action: (chain: ReturnType<NonNullable<Editor>["chain"]>) => unknown) => () => { if (editor) action(editor.chain().focus()); };
  const tool = (name: string, shortcut: string | null, Icon: typeof Bold, onClick: () => void, active?: boolean) => {
    const text = shortcut ? withShortcut(name, shortcut) : name;
    return <button key={name} type="button" className="editor-tool" aria-label={name} title={text} aria-pressed={active} onMouseDown={(event) => event.preventDefault()} onClick={onClick}><Icon aria-hidden size={14} /></button>;
  };
  const separator = <span key="sep" aria-hidden className="editor-tool-sep" />;
  const ed = editor;
  return <div role="toolbar" aria-label={label} data-testid={testId} className="editor-toolbar">
    {tool(translate("wiki.tool.bold"), "B", Bold, run((chain) => chain.toggleBold().run()), ed?.isActive("bold"))}
    {tool(translate("wiki.tool.italic"), "I", Italic, run((chain) => chain.toggleItalic().run()), ed?.isActive("italic"))}
    {tool(translate("wiki.tool.underline"), "U", Underline, run((chain) => chain.toggleUnderline().run()), ed?.isActive("underline"))}
    {tool(translate("wiki.tool.strike"), "Shift+S", Strikethrough, run((chain) => chain.toggleStrike().run()), ed?.isActive("strike"))}
    {tool(translate("wiki.tool.code"), "E", Code, run((chain) => chain.toggleCode().run()), ed?.isActive("code"))}
    {separator}
    {tool(translate("wiki.tool.bulletList"), "Shift+8", List, run((chain) => chain.toggleBulletList().run()), ed?.isActive("bulletList"))}
    {tool(translate("wiki.tool.orderedList"), "Shift+7", ListOrdered, run((chain) => chain.toggleOrderedList().run()), ed?.isActive("orderedList"))}
    {tool(translate("wiki.insert.todo"), "Shift+9", ListChecks, run((chain) => chain.toggleTaskList().run()), ed?.isActive("taskList"))}
    {tool(translate("wiki.tool.quote"), "Shift+B", Quote, run((chain) => chain.toggleBlockquote().run()), ed?.isActive("blockquote"))}
    {separator}
    <LinkButton key="link" editor={editor} iconOnly />
    {tool(translate("wiki.insert.table"), null, Table2, run((chain) => chain.insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()))}
    {tool(translate("wiki.insert.image"), null, ImagePlus, onImage)}
    <span className="editor-toolbar-end">
      {end}
      {source && <SourceModeButton active={source.active} onClick={source.onToggle} />}
    </span>
  </div>;
}
