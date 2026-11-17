import React from "react";
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
import { EditorSourceMode, editorLimitWarnings } from "./editor-source-mode";
import { EditorToolbar } from "./editor-toolbar";

/** Work item description: a Tiptap editor that accepts pasted or dropped images, owned by the work item. */
/** The owner passes its save status as `status`; it sits at the end of the toolbar. */
export function DescriptionEditor({ workspaceId, workItemId, initial, editable, onChange, onSourceDraftChange, status }: { workspaceId: string; workItemId: string; initial: unknown; editable: boolean; onChange: (doc: unknown) => void; onSourceDraftChange?: (hasDraft: boolean) => void; status?: React.ReactNode }) {
  const sourceToggle = React.useRef<(() => void) | null>(null);
  const [sourceActive, setSourceActive] = React.useState(false);
  const { extension, error, uploadFile } = useAssetImages(editable ? { ownerType: "work_item", ownerId: workItemId } : null);
  const picker = React.useRef<HTMLInputElement>(null);
  const limitWarnings = React.useMemo(() => editorLimitWarnings(initial), [initial]);
  const editor = useEditor({
    extensions: [...surfaceEditorExtensions({ surface: "full", image: extension }), ListIndent, MarkdownPaste, CodeBlockCopy, EmojiSuggestions, AiAssist, SlashMenu.configure({ commands: [...blockCommands, ...wikiCommands.filter((command) => ["todo", "table", "callout", "emoji", "color", "image"].includes(command.id))], onImage: () => picker.current?.click() }), SafeLinkClick, EditorPlaceholder], content: normalizeAssetImages((initial as object | null) ?? ""), editable,
    onUpdate: ({ editor: current }) => onChange(current.getJSON()),
  });
  return <div>
    {editable
      ? <EditorToolbar editor={editor} label={translate("wiki.toolbar")} testId="description-toolbar" onImage={() => picker.current?.click()} source={editor?.isEditable ? { active: sourceActive, onToggle: () => sourceToggle.current?.() } : undefined} end={status} />
      : <div className="mb-1 flex min-h-7 justify-end">{status}</div>}
    <div className="comment-editor relative" data-testid="description-editor"><EditorSourceMode editor={editable ? editor : null} initialWarnings={limitWarnings} onSourceDraftChange={onSourceDraftChange} toggleRef={sourceToggle} onModeChange={setSourceActive} /><CalloutControls editor={editor} editable={editable} /><CodeBlockControls editor={editor} editable={editable} /><TableControls editor={editor} editable={editable} /><EditorContent editor={editor} aria-label={translate("workItems.description")} /><WikiBlockControls editor={editor} editable={editable} /><WikiBubbleMenu editor={editable ? editor : null} /></div>
    {editable && <><input ref={picker} data-testid="description-image-input" hidden type="file" accept="image/png,image/jpeg,image/gif,image/webp" onChange={async (event) => { const file = event.target.files?.[0]; event.target.value = ""; if (!file || !editor) return; const assetId = await uploadFile(file); if (assetId) editor.commands.insertContentAt(editor.state.doc.content.size, { type: "assetImage", attrs: { assetId } }); }} /><AssistMenu editor={editor} workspaceId={workspaceId} /></>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
