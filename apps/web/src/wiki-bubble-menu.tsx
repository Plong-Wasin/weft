import React from "react";
import { flushSync } from "react-dom";
import { BubbleMenu as TiptapBubbleMenu } from "@tiptap/react/menus";
import type { Editor } from "@tiptap/react";
import { Bold, Code, Italic, Link as LinkIcon, Palette, RotateCcw, Strikethrough, Underline } from "lucide-react";
import { translate } from "@weft/shared";
import { editorPalette } from "../../../packages/actions/src/wiki-editor-extensions";
import { OPEN_LINK_EVENT, withShortcut } from "./shortcuts";

const keepSelection = (event: React.MouseEvent) => event.preventDefault();

/** The one popover open at a time: the Link form or the colour panel (Text color and Highlight). */
type Panel = "link" | "color";

export function WikiBubbleMenu({ editor }: { editor: Editor | null }) {
  const [url, setUrl] = React.useState("");
  const [panel, setPanel] = React.useState<Panel | null>(null);
  const root = React.useRef<HTMLDivElement>(null);
  const triggers = React.useRef<Partial<Record<Panel, HTMLButtonElement | null>>>({});
  const linkInput = React.useRef<HTMLInputElement>(null);
  // Tiptap re-dispatches a transaction whenever this prop changes identity, so it must stay stable across renders.
  const shouldShow = React.useCallback(({ state }: { state: { selection: { from: number; to: number } } }) => state.selection.from !== state.selection.to && Boolean(editor?.isEditable), [editor]);
  // Ctrl/Cmd+K opens the Link field here now that the fixed toolbar's Link button is gone.
  React.useEffect(() => {
    const onShortcut = (event: Event) => {
      // Only claim the shortcut when the bubble shows (a non-empty selection): with a collapsed cursor the browser keeps its own Ctrl+K, and no panel opens for a later selection.
      if (!editor?.isFocused || !editor.isEditable || editor.state.selection.empty) return;
      (event as CustomEvent<{ claimed: boolean }>).detail.claimed = true;
      flushSync(() => setPanel("link"));
      linkInput.current?.focus();
    };
    document.addEventListener(OPEN_LINK_EVENT, onShortcut);
    return () => document.removeEventListener(OPEN_LINK_EVENT, onShortcut);
  }, [editor]);
  // A popover opened from its button focuses its first field; any click outside the toolbar closes it.
  React.useEffect(() => {
    if (panel === "link") linkInput.current?.focus();
    if (!panel) return;
    const onPointerDown = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setPanel(null); };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [panel]);
  if (!editor) return null;
  const linkActive = editor.isActive("link");
  const linkAttrs = editor.getAttributes("link");
  const colorActive = Boolean(editor.getAttributes("textStyle").color) || editor.isActive("highlight");
  const block = editor.isActive("heading") ? `h${editor.getAttributes("heading").level}` : editor.isActive("bulletList") ? "bulletList" : editor.isActive("orderedList") ? "orderedList" : editor.isActive("blockquote") ? "blockquote" : editor.isActive("codeBlock") ? "codeBlock" : "paragraph";
  const button = (name: string, icon: React.ReactNode, active: boolean, action: () => void, shortcut?: string) => <button type="button" aria-label={name} title={shortcut ? withShortcut(name, shortcut) : name} aria-pressed={active} className={`wiki-bubble-button${active ? " is-active" : ""}`} onMouseDown={keepSelection} onClick={action}>{icon}</button>;
  const trigger = (id: Panel, name: string, icon: React.ReactNode, active: boolean, shortcut?: string) => <button type="button" ref={(node) => { triggers.current[id] = node; }} aria-label={name} title={shortcut ? withShortcut(name, shortcut) : name} aria-expanded={panel === id} className={`wiki-bubble-button${active ? " is-active" : ""}`} onMouseDown={keepSelection} onClick={() => setPanel(panel === id ? null : id)}>{icon}</button>;
  const colorName = (color: string) => translate(`wiki.color.${["red", "orange", "yellow", "green", "cyan", "blue", "violet", "pink"][editorPalette.indexOf(color as never)]}` as never);
  const glyph = { size: 16, "aria-hidden": true, strokeWidth: 2 } as const;
  return <TiptapBubbleMenu editor={editor} shouldShow={shouldShow}>
    <div ref={root} className="wiki-bubble-menu" role="toolbar" aria-label={translate("wiki.bubbleMenu")} data-testid="wiki-bubble-menu" onKeyDown={(event) => {
      if (event.key !== "Escape" || !panel) return;
      event.stopPropagation();
      const closing = panel;
      setPanel(null);
      triggers.current[closing]?.focus();
    }}>
      <select className="wiki-bubble-select" aria-label={translate("wiki.tool.blockType")} value={block} onMouseDown={keepSelection} onChange={(event) => {
        const value = event.target.value; const chain = editor.chain().focus();
        if (value === "paragraph") chain.setParagraph().run();
        else if (value.startsWith("h")) chain.setHeading({ level: Number(value.slice(1)) as 1 | 2 | 3 | 4 | 5 | 6 }).run();
        else if (value === "bulletList") chain.toggleBulletList().run(); else if (value === "orderedList") chain.toggleOrderedList().run();
        else if (value === "blockquote") chain.toggleBlockquote().run(); else if (value === "codeBlock") chain.toggleCodeBlock().run();
      }}>
        <option value="paragraph">{translate("wiki.tool.text")}</option>{[1, 2, 3, 4, 5, 6].map((level) => <option key={level} value={`h${level}`}>{translate(`wiki.tool.h${level}` as never)}</option>)}
        <option value="bulletList">{translate("wiki.tool.bulletList")}</option><option value="orderedList">{translate("wiki.tool.orderedList")}</option><option value="blockquote">{translate("wiki.tool.quote")}</option><option value="codeBlock">{translate("wiki.tool.codeBlock")}</option>
      </select>
      {button(translate("wiki.tool.bold"), <Bold {...glyph} />, editor.isActive("bold"), () => editor.chain().focus().toggleBold().run(), "B")}
      {button(translate("wiki.tool.italic"), <Italic {...glyph} />, editor.isActive("italic"), () => editor.chain().focus().toggleItalic().run(), "I")}
      {button(translate("wiki.tool.underline"), <Underline {...glyph} />, editor.isActive("underline"), () => editor.chain().focus().toggleUnderline().run(), "U")}
      {button(translate("wiki.tool.strike"), <Strikethrough {...glyph} />, editor.isActive("strike"), () => editor.chain().focus().toggleStrike().run(), "Shift+S")}
      {button(translate("wiki.tool.code"), <Code {...glyph} />, editor.isActive("code"), () => editor.chain().focus().toggleCode().run(), "E")}
      <span className="wiki-bubble-anchor">{trigger("link", translate("wiki.tool.link"), <LinkIcon {...glyph} />, linkActive, "K")}
        {panel === "link" && <div className="wiki-bubble-popover wiki-bubble-link-popover" role="group" aria-label={translate("wiki.tool.link")}><form onSubmit={(event) => { event.preventDefault(); if (!url.trim()) return; editor.chain().focus().setLink({ href: url.trim() }).run(); setPanel(null); }}><input ref={linkInput} aria-label={translate("wiki.linkUrl")} value={url || String(linkAttrs.href ?? "")} onChange={(event) => setUrl(event.target.value)} placeholder={translate("wiki.linkPlaceholder")}/><button type="submit">{translate("wiki.linkSave")}</button>{linkActive && <button type="button" onMouseDown={keepSelection} onClick={() => { editor.chain().focus().unsetLink().run(); setUrl(""); setPanel(null); }}>{translate("wiki.linkRemove")}</button>}</form></div>}</span>
      <span className="wiki-bubble-anchor">{trigger("color", translate("wiki.tool.colors"), <Palette {...glyph} />, colorActive)}
        {panel === "color" && <div className="wiki-bubble-popover wiki-bubble-color-popover" role="group" aria-label={translate("wiki.tool.colors")} data-testid="wiki-bubble-colors">
        <fieldset><legend>{translate("wiki.insert.color")}</legend><button type="button" className="wiki-bubble-reset" aria-label={translate("wiki.tool.resetTextColor")} title={translate("wiki.tool.resetTextColor")} onMouseDown={keepSelection} onClick={() => editor.chain().focus().unsetColor().run()}><RotateCcw {...glyph} size={12} /></button>{editorPalette.map((color, index) => <button type="button" key={color} className="wiki-bubble-swatch" aria-label={`${translate("wiki.insert.color")} ${colorName(color)}`} title={`${translate("wiki.insert.color")} ${colorName(color)}`} style={{ backgroundColor: `var(--editor-palette-${index})` }} onMouseDown={keepSelection} onClick={() => editor.chain().focus().setColor(color).run()} />)}</fieldset>
        <fieldset><legend>{translate("wiki.highlight")}</legend><button type="button" className="wiki-bubble-reset" aria-label={translate("wiki.tool.resetHighlight")} title={translate("wiki.tool.resetHighlight")} onMouseDown={keepSelection} onClick={() => editor.chain().focus().unsetHighlight().run()}><RotateCcw {...glyph} size={12} /></button>{editorPalette.map((color, index) => <button type="button" key={color} className="wiki-bubble-swatch" aria-label={`${translate("wiki.highlight")} ${colorName(color)}`} title={`${translate("wiki.highlight")} ${colorName(color)}`} style={{ backgroundColor: `var(--editor-palette-${index})` }} onMouseDown={keepSelection} onClick={() => editor.chain().focus().setHighlight({ color }).run()} />)}</fieldset>
      </div>}</span>
    </div>
  </TiptapBubbleMenu>;
}
