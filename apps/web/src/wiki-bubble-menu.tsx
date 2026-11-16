import React from "react";
import { BubbleMenu as TiptapBubbleMenu } from "@tiptap/react/menus";
import type { Editor } from "@tiptap/react";
import { translate } from "@weft/shared";
import { editorPalette } from "../../../packages/actions/src/wiki-editor-extensions";
import { OPEN_LINK_EVENT, withShortcut } from "./shortcuts";

const keepSelection = (event: React.MouseEvent) => event.preventDefault();

export function WikiBubbleMenu({ editor }: { editor: Editor | null }) {
  const [url, setUrl] = React.useState("");
  const linkDetails = React.useRef<HTMLDetailsElement>(null);
  // Tiptap re-dispatches a transaction whenever this prop changes identity, so it must stay stable across renders.
  const shouldShow = React.useCallback(({ state }: { state: { selection: { from: number; to: number } } }) => state.selection.from !== state.selection.to && Boolean(editor?.isEditable), [editor]);
  // Ctrl/Cmd+K opens the Link field here now that the fixed toolbar's Link button is gone.
  React.useEffect(() => {
    const onShortcut = () => {
      if (!editor?.isFocused || !editor.isEditable || !linkDetails.current) return;
      linkDetails.current.open = true;
      linkDetails.current.querySelector("input")?.focus();
    };
    document.addEventListener(OPEN_LINK_EVENT, onShortcut);
    return () => document.removeEventListener(OPEN_LINK_EVENT, onShortcut);
  }, [editor]);
  if (!editor) return null;
  const linkActive = editor.isActive("link");
  const linkAttrs = editor.getAttributes("link");
  const block = editor.isActive("heading") ? `h${editor.getAttributes("heading").level}` : editor.isActive("bulletList") ? "bulletList" : editor.isActive("orderedList") ? "orderedList" : editor.isActive("blockquote") ? "blockquote" : editor.isActive("codeBlock") ? "codeBlock" : "paragraph";
  const button = (name: string, glyph: string, active: boolean, action: () => void, shortcut?: string) => <button type="button" aria-label={name} title={shortcut ? withShortcut(name, shortcut) : name} aria-pressed={active} className={`wiki-bubble-button${active ? " is-active" : ""}`} onMouseDown={keepSelection} onClick={action}>{glyph}</button>;
  const colorName = (color: string) => translate(`wiki.color.${["red", "orange", "yellow", "green", "cyan", "blue", "violet", "pink"][editorPalette.indexOf(color as never)]}` as never);
  return <TiptapBubbleMenu editor={editor} shouldShow={shouldShow}>
    <div className="wiki-bubble-menu" role="toolbar" aria-label={translate("wiki.bubbleMenu")} data-testid="wiki-bubble-menu">
      <select aria-label={translate("wiki.tool.blockType")} value={block} onMouseDown={keepSelection} onChange={(event) => {
        const value = event.target.value; const chain = editor.chain().focus();
        if (value === "paragraph") chain.setParagraph().run();
        else if (value.startsWith("h")) chain.setHeading({ level: Number(value.slice(1)) as 1 | 2 | 3 | 4 | 5 | 6 }).run();
        else if (value === "bulletList") chain.toggleBulletList().run(); else if (value === "orderedList") chain.toggleOrderedList().run();
        else if (value === "blockquote") chain.toggleBlockquote().run(); else if (value === "codeBlock") chain.toggleCodeBlock().run();
      }}>
        <option value="paragraph">{translate("wiki.tool.text")}</option>{[1, 2, 3, 4, 5, 6].map((level) => <option key={level} value={`h${level}`}>{translate(`wiki.tool.h${level}` as never)}</option>)}
        <option value="bulletList">{translate("wiki.tool.bulletList")}</option><option value="orderedList">{translate("wiki.tool.orderedList")}</option><option value="blockquote">{translate("wiki.tool.quote")}</option><option value="codeBlock">{translate("wiki.tool.codeBlock")}</option>
      </select>
      {button(translate("wiki.tool.bold"), "B", editor.isActive("bold"), () => editor.chain().focus().toggleBold().run(), "B")}
      {button(translate("wiki.tool.italic"), "I", editor.isActive("italic"), () => editor.chain().focus().toggleItalic().run(), "I")}
      {button(translate("wiki.tool.underline"), translate("wiki.tool.underline"), editor.isActive("underline"), () => editor.chain().focus().toggleUnderline().run())}
      {button(translate("wiki.tool.strike"), "S", editor.isActive("strike"), () => editor.chain().focus().toggleStrike().run(), "Shift+S")}
      {button(translate("wiki.tool.code"), "</>", editor.isActive("code"), () => editor.chain().focus().toggleCode().run(), "E")}
      <details ref={linkDetails} className="wiki-bubble-link"><summary onMouseDown={keepSelection} title={withShortcut(translate("wiki.tool.link"), "K")}>{translate("wiki.tool.link")}</summary><form onSubmit={(event) => { event.preventDefault(); if (url.trim()) editor.chain().focus().setLink({ href: url.trim() }).run(); }}><input aria-label={translate("wiki.linkUrl")} value={url || String(linkAttrs.href ?? "")} onMouseDown={keepSelection} onChange={(event) => setUrl(event.target.value)} placeholder={translate("wiki.linkPlaceholder")}/><button type="submit">{translate("wiki.linkSave")}</button>{linkActive && <button type="button" onMouseDown={keepSelection} onClick={() => { editor.chain().focus().unsetLink().run(); setUrl(""); }}>{translate("wiki.linkRemove")}</button>}</form></details>
      <fieldset><legend>{translate("wiki.insert.color")}</legend><button type="button" aria-label={translate("wiki.colorDefault")} title={translate("wiki.colorDefault")} onMouseDown={keepSelection} onClick={() => editor.chain().focus().unsetColor().run()}>↺</button>{editorPalette.map((color, index) => <button type="button" key={color} aria-label={`${translate("wiki.insert.color")} ${colorName(color)}`} title={`${translate("wiki.insert.color")} ${colorName(color)}`} style={{ backgroundColor: `var(--editor-palette-${index})` }} onMouseDown={keepSelection} onClick={() => editor.chain().focus().setColor(color).run()} />)}</fieldset>
      <fieldset><legend>{translate("wiki.highlight")}</legend><button type="button" aria-label={translate("wiki.colorDefault")} title={translate("wiki.colorDefault")} onMouseDown={keepSelection} onClick={() => editor.chain().focus().unsetHighlight().run()}>↺</button>{editorPalette.map((color, index) => <button type="button" key={color} aria-label={`${translate("wiki.highlight")} ${colorName(color)}`} title={`${translate("wiki.highlight")} ${colorName(color)}`} style={{ backgroundColor: `var(--editor-palette-${index})` }} onMouseDown={keepSelection} onClick={() => editor.chain().focus().setHighlight({ color }).run()} />)}</fieldset>
    </div>
  </TiptapBubbleMenu>;
}
