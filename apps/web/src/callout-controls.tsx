import React from "react";
import { translate } from "@weft/shared";
import { editorPalette } from "../../../packages/actions/src/wiki-editor-extensions";
import type { Editor } from "@tiptap/react";

const icons = ["💡", "ℹ️", "⚠️", "✅", "❗", "❤️", "🚀", "🎉"];

/** Controls the active callout's shared palette colour and icon. */
export function CalloutControls({ editor, editable }: { editor: Editor | null; editable: boolean }) {
  const [open, setOpen] = React.useState(false);
  if (!editable || !editor) return null;
  return <div className="callout-controls">
    <button type="button" aria-label={translate("callout.options")} aria-expanded={open} onMouseDown={(event) => event.preventDefault()} onClick={() => setOpen((value) => !value)}>{translate("callout.options")}</button>
    {open && <div className="callout-picker" role="group" aria-label={translate("callout.options")}>
      <div className="callout-picker-colors" aria-label={translate("callout.color")}>
        {editorPalette.map((color) => <button key={color} type="button" aria-label={`${translate("callout.color")} ${color}`} title={color} style={{ backgroundColor: color }} onMouseDown={(event) => event.preventDefault()} onClick={() => editor.chain().focus().updateAttributes("callout", { color }).run()} />)}
      </div>
      <div className="callout-picker-icons" aria-label={translate("callout.icon")}>
        {icons.map((icon) => <button key={icon} type="button" aria-label={`${translate("callout.icon")} ${icon}`} onMouseDown={(event) => event.preventDefault()} onClick={() => editor.chain().focus().updateAttributes("callout", { icon }).run()}>{icon}</button>)}
      </div>
      <button type="button" onClick={() => setOpen(false)}>{translate("callout.done")}</button>
    </div>}
  </div>;
}
