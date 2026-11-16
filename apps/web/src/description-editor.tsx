import React from "react";
import { ImagePlus, List, ListOrdered, Table2 } from "lucide-react";
import { LinkButton } from "./link-button";
import { withShortcut } from "./shortcuts";
import { EditorContent, useEditor } from "@tiptap/react";
import { translate } from "@weft/shared";
import { useAssetImages } from "./asset-images";
import { AssistMenu } from "./assist-menu";
import { AiAssist } from "./editor-assist";
import { CodeBlockCopy, EditorPlaceholder, EmojiSuggestions, ListIndent, MarkdownPaste, SafeLinkClick, SlashMenu, blockCommands, surfaceEditorExtensions, wikiCommands } from "./editor-extensions";
import { TableControls } from "./table-controls";
import { normalizeAssetImages } from "../../../packages/actions/src/wiki-yjs";
import { CalloutControls } from "./callout-controls";
import { CodeBlockControls } from "./code-block-controls";
import { WikiBubbleMenu } from "./wiki-bubble-menu";
import { WikiBlockControls } from "./wiki-block-controls";

/** Work item description: a Tiptap editor that accepts pasted or dropped images, owned by the work item. */
export function DescriptionEditor({ workspaceId, workItemId, initial, editable, onChange }: { workspaceId: string; workItemId: string; initial: unknown; editable: boolean; onChange: (doc: unknown) => void }) {
  const { extension, error, uploadFile } = useAssetImages(editable ? { ownerType: "work_item", ownerId: workItemId } : null);
  const picker = React.useRef<HTMLInputElement>(null);
  const editor = useEditor({
    extensions: [...surfaceEditorExtensions({ surface: "full", image: extension }), ListIndent, MarkdownPaste, CodeBlockCopy, EmojiSuggestions, AiAssist, SlashMenu.configure({ commands: [...blockCommands, ...wikiCommands.filter((command) => ["todo", "table", "callout", "emoji", "color", "image"].includes(command.id))], onImage: () => picker.current?.click() }), SafeLinkClick, EditorPlaceholder], content: normalizeAssetImages((initial as object | null) ?? ""), editable,
    onUpdate: ({ editor: current }) => onChange(current.getJSON()),
  });
  return <div>
    <div className="comment-editor relative" data-testid="description-editor"><CalloutControls editor={editor} editable={editable} /><CodeBlockControls editor={editor} editable={editable} /><TableControls editor={editor} editable={editable} /><EditorContent editor={editor} aria-label={translate("workItems.description")} /><WikiBlockControls editor={editor} editable={editable} /><WikiBubbleMenu editor={editable ? editor : null} />{editable && <><div role="toolbar" aria-label={translate("wiki.toolbar")} className="mt-2 flex flex-wrap gap-1"><button type="button" className="editor-tool-label" aria-label={translate("wiki.insert.image")} title={translate("wiki.insert.image")} onClick={() => picker.current?.click()}><ImagePlus aria-hidden size={14} /><span>{translate("wiki.insert.image")}</span></button><button type="button" className="editor-tool-label" aria-label={translate("wiki.tool.bulletList")} title={withShortcut(translate("wiki.tool.bulletList"), "Shift+8")} onMouseDown={(event) => event.preventDefault()} onClick={() => editor?.chain().focus().toggleBulletList().run()}><List aria-hidden size={14} /><span>{translate("wiki.tool.bulletList")}</span></button><button type="button" className="editor-tool-label" aria-label={translate("wiki.tool.orderedList")} title={withShortcut(translate("wiki.tool.orderedList"), "Shift+7")} onMouseDown={(event) => event.preventDefault()} onClick={() => editor?.chain().focus().toggleOrderedList().run()}><ListOrdered aria-hidden size={14} /><span>{translate("wiki.tool.orderedList")}</span></button><button type="button" className="editor-tool-label" aria-label={translate("wiki.insert.table")} title={translate("wiki.insert.table")} onClick={() => editor?.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}><Table2 aria-hidden size={14} /><span>{translate("wiki.insert.table")}</span></button><LinkButton editor={editor} /></div><input ref={picker} data-testid="description-image-input" hidden type="file" accept="image/png,image/jpeg,image/gif,image/webp" onChange={async (event) => { const file = event.target.files?.[0]; event.target.value = ""; if (!file || !editor) return; const assetId = await uploadFile(file); if (assetId) editor.commands.insertContentAt(editor.state.doc.content.size, { type: "assetImage", attrs: { assetId } }); }} /><AssistMenu editor={editor} workspaceId={workspaceId} /></>}</div>
    {error && <p role="alert">{error}</p>}
  </div>;
}
