import React from "react";
import { ImagePlus } from "lucide-react";
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
    extensions: [...surfaceEditorExtensions({ surface: "full", image: extension }), ListIndent, MarkdownPaste, CodeBlockCopy, EmojiSuggestions, AiAssist, SlashMenu.configure({ commands: [...blockCommands, ...wikiCommands.filter((command) => ["todo", "table", "callout", "emoji", "color"].includes(command.id))] }), SafeLinkClick, EditorPlaceholder], content: normalizeAssetImages((initial as object | null) ?? ""), editable,
    onUpdate: ({ editor: current }) => onChange(current.getJSON()),
  });
  return <div>
    <div className="comment-editor relative" data-testid="description-editor"><CalloutControls editor={editor} editable={editable} /><CodeBlockControls editor={editor} editable={editable} /><TableControls editor={editor} editable={editable} /><EditorContent editor={editor} aria-label={translate("workItems.description")} /><WikiBlockControls editor={editor} editable={editable} /><WikiBubbleMenu editor={editable ? editor : null} />{editable && <><button type="button" aria-label={translate("wiki.insert.image")} title={translate("wiki.insert.image")} onClick={() => picker.current?.click()}><ImagePlus size={14} /></button><input ref={picker} data-testid="description-image-input" hidden type="file" accept="image/png,image/jpeg,image/gif,image/webp" onChange={async (event) => { const file = event.target.files?.[0]; event.target.value = ""; if (!file || !editor) return; const assetId = await uploadFile(file); if (assetId) editor.commands.insertContentAt(editor.state.doc.content.size, { type: "assetImage", attrs: { assetId } }); }} /><AssistMenu editor={editor} workspaceId={workspaceId} /></>}</div>
    {error && <p role="alert">{error}</p>}
  </div>;
}
