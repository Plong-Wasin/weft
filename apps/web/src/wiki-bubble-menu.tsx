import React from "react";
import { BubbleMenu as TiptapBubbleMenu } from "@tiptap/react/menus";
import type { Editor } from "@tiptap/react";
import { translate } from "@weft/shared";
import { editorPalette } from "../../../packages/actions/src/wiki-editor-extensions";

const keepSelection = (event: React.MouseEvent) => event.preventDefault();

export function WikiBubbleMenu({ editor }: { editor: Editor | null }) {
  const [url, setUrl] = React.useState("");
  if (!editor) return null;
  const linkActive = editor.isActive("link");
  const linkAttrs = editor.getAttributes("link");
  const alignmentSupported = editor.isActive("paragraph") || editor.isActive("heading");
  const block = editor.isActive("heading") ? `h${editor.getAttributes("heading").level}` : editor.isActive("bulletList") ? "bulletList" : editor.isActive("orderedList") ? "orderedList" : editor.isActive("blockquote") ? "blockquote" : editor.isActive("codeBlock") ? "codeBlock" : "paragraph";
  const button = (label: string, active: boolean, action: () => void) => <button type="button" aria-label={label} aria-pressed={active} className={`wiki-bubble-button${active ? " is-active" : ""}`} onMouseDown={keepSelection} onClick={action}>{label}</button>;
  return <TiptapBubbleMenu editor={editor} shouldShow={({ state }) => state.selection.from !== state.selection.to && editor.isEditable}>
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
      {button("B", editor.isActive("bold"), () => editor.chain().focus().toggleBold().run())}
      {button("I", editor.isActive("italic"), () => editor.chain().focus().toggleItalic().run())}
      {button(translate("wiki.tool.underline"), editor.isActive("underline"), () => editor.chain().focus().toggleUnderline().run())}
      {button("S", editor.isActive("strike"), () => editor.chain().focus().toggleStrike().run())}
      {button("</>", editor.isActive("code"), () => editor.chain().focus().toggleCode().run())}
      <details className="wiki-bubble-link"><summary onMouseDown={keepSelection}>{translate("wiki.tool.link")}</summary><form onSubmit={(event) => { event.preventDefault(); if (url.trim()) editor.chain().focus().setLink({ href: url.trim() }).run(); }}><input aria-label={translate("wiki.linkUrl")} value={url || String(linkAttrs.href ?? "")} onMouseDown={keepSelection} onChange={(event) => setUrl(event.target.value)} placeholder="https://"/><button type="submit">{translate("wiki.linkSave")}</button>{linkActive && <button type="button" onMouseDown={keepSelection} onClick={() => { editor.chain().focus().unsetLink().run(); setUrl(""); }}>{translate("wiki.linkRemove")}</button>}</form></details>
      <fieldset><legend>{translate("wiki.insert.color")}</legend><button type="button" aria-label={translate("wiki.colorDefault")} onMouseDown={keepSelection} onClick={() => editor.chain().focus().unsetColor().run()}>↺</button>{editorPalette.map((color, index) => <button type="button" key={color} aria-label={`${translate("wiki.insert.color")} ${color}`} style={{ backgroundColor: `var(--editor-palette-${index})` }} onMouseDown={keepSelection} onClick={() => editor.chain().focus().setColor(color).run()} />)}</fieldset>
      <fieldset><legend>{translate("wiki.highlight")}</legend><button type="button" aria-label={translate("wiki.colorDefault")} onMouseDown={keepSelection} onClick={() => editor.chain().focus().unsetHighlight().run()}>↺</button>{editorPalette.map((color, index) => <button type="button" key={color} aria-label={`${translate("wiki.highlight")} ${color}`} style={{ backgroundColor: `var(--editor-palette-${index})` }} onMouseDown={keepSelection} onClick={() => editor.chain().focus().setHighlight({ color }).run()} />)}</fieldset>
      {alignmentSupported && <>{button("←", editor.isActive({ textAlign: "left" }), () => editor.chain().focus().setTextAlign("left").run())}{button("↔", editor.isActive({ textAlign: "center" }), () => editor.chain().focus().setTextAlign("center").run())}{button("→", editor.isActive({ textAlign: "right" }), () => editor.chain().focus().setTextAlign("right").run())}</>}
    </div>
  </TiptapBubbleMenu>;
}
