import { Button } from "@/ui/button";
import React from "react";
import { translate } from "@weft/shared";
import { editorPalette } from "../../../packages/actions/src/wiki-editor-extensions";
import { writtenFormCalloutIcons } from "../../../packages/actions/src/written-form-attributes";
import type { Editor } from "@tiptap/react";
import { useEditorState } from "@tiptap/react";


/** Controls the active callout's shared palette colour and icon. */
export function CalloutControls({ editor, editable }: { editor: Editor | null; editable: boolean }) {
  const [open, setOpen] = React.useState(false);
  const active = useEditorState({ editor, selector: ({ editor: current }) => !!current?.isActive("callout") });
  if (!editable || !editor || !active) return null;
  return <div className="callout-controls">
    <Button type="button" aria-label={translate("callout.options")} aria-expanded={open} onMouseDown={(event) => event.preventDefault()} onClick={() => setOpen((value) => !value)}>{translate("callout.options")}</Button>
    {open && <div className="callout-picker" role="group" aria-label={translate("callout.options")}>
      <div className="callout-picker-colors" aria-label={translate("callout.color")}>
        {editorPalette.map((color) => <Button key={color} type="button" aria-label={`${translate("callout.color")} ${color}`} title={color} style={{ backgroundColor: color }} onMouseDown={(event) => event.preventDefault()} onClick={() => editor.chain().focus().updateAttributes("callout", { color }).run()} />)}
      </div>
      <div className="callout-picker-icons" aria-label={translate("callout.icon")}>
        {writtenFormCalloutIcons.map((icon) => <Button key={icon} type="button" aria-label={`${translate("callout.icon")} ${icon}`} onMouseDown={(event) => event.preventDefault()} onClick={() => editor.chain().focus().updateAttributes("callout", { icon }).run()}>{icon}</Button>)}
      </div>
      <Button type="button" onClick={() => setOpen(false)}>{translate("callout.done")}</Button>
    </div>}
  </div>;
}
