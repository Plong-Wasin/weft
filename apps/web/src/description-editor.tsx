import React from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import { translate } from "@weft/shared";
import { useAssetImages } from "./asset-images";
import { AssistMenu } from "./assist-menu";
import { AiAssist } from "./editor-assist";
import { BlockKeyboardShortcuts, CodeBlockCopy, EditorPlaceholder, EmojiSuggestions, ListIndent, MarkdownPaste, SafeLinkClick, SlashMenu, blockCommands, surfaceEditorExtensions, wikiCommands } from "./editor-extensions";
import { TableControls } from "./table-controls";
import { normalizeAssetImages } from "../../../packages/actions/src/wiki-yjs";
import { CalloutControls } from "./callout-controls";
import { CodeBlockControls } from "./code-block-controls";
import { WikiBubbleMenu } from "./wiki-bubble-menu";
import { WikiBlockControls } from "./wiki-block-controls";
import { EditorSourceMode, editorLimitWarnings } from "./editor-source-mode";
import { EditorToolbar } from "./editor-toolbar";
import { ReferencePicker } from "./reference-picker";
import type { OwnerRef } from "./asset-upload";
import { mentionExtension, type MentionPerson } from "./mention-extension";
export type DescriptionMentionPerson = MentionPerson;

/** Work item description: a Tiptap editor that accepts pasted or dropped images, owned by the work item. */
/** The owner passes its save status as `status`; it sits at the end of the toolbar. */
export function DescriptionEditor({ workspaceId, workItemId, owner, mentionPeople = [], initial, editable, imageUploads = true, onChange, onSourceDraftChange, status }: { workspaceId: string; workItemId?: string | null; owner?: OwnerRef; mentionPeople?: DescriptionMentionPerson[]; initial: unknown; editable: boolean; imageUploads?: boolean; onChange: (doc: unknown) => void; onSourceDraftChange?: (hasDraft: boolean) => void; status?: React.ReactNode }) {
  const peopleRef = React.useRef(mentionPeople);
  peopleRef.current = mentionPeople;
  const sourceToggle = React.useRef<(() => void) | null>(null);
  const [sourceActive, setSourceActive] = React.useState(false);
  const imageOwner = owner ?? (workItemId ? { ownerType: "work_item" as const, ownerId: workItemId } : null);
  const { extension, error, uploadFile } = useAssetImages(editable && imageUploads ? imageOwner : null);
  const picker = React.useRef<HTMLInputElement>(null);
  const limitWarnings = React.useMemo(() => editorLimitWarnings(initial), [initial]);
  const editor = useEditor({
    extensions: [...surfaceEditorExtensions({ surface: "full", mention: mentionExtension(peopleRef), image: extension }), ListIndent, BlockKeyboardShortcuts, MarkdownPaste, CodeBlockCopy, EmojiSuggestions, ReferencePicker.configure({ workspaceId }), AiAssist, SlashMenu.configure({ commands: [...blockCommands, ...wikiCommands.filter((command) => ["todo", "table", "callout", "emoji", "color", "image"].includes(command.id))], onImage: () => picker.current?.click() }), SafeLinkClick, EditorPlaceholder], content: normalizeAssetImages((initial as object | null) ?? ""), editable,
    onUpdate: ({ editor: current }) => onChange(current.getJSON()),
  });
  React.useEffect(() => { editor?.setEditable(editable); }, [editor, editable]);
  return <div>
    {editable
      ? <EditorToolbar editor={editor} label={translate("wiki.toolbar")} testId="description-toolbar" onImage={imageUploads && workItemId ? () => picker.current?.click() : undefined} source={editor?.isEditable ? { active: sourceActive, onToggle: () => sourceToggle.current?.() } : undefined} end={status} />
      : <div className="mb-1 flex min-h-7 justify-end">{status}</div>}
    <div className="comment-editor relative" data-testid="description-editor"><EditorSourceMode editor={editable ? editor : null} initialWarnings={limitWarnings} onSourceDraftChange={onSourceDraftChange} toggleRef={sourceToggle} onModeChange={setSourceActive} /><CalloutControls editor={editor} editable={editable} /><CodeBlockControls editor={editor} editable={editable} /><TableControls editor={editor} editable={editable} /><EditorContent editor={editor} aria-label={translate("workItems.description")} /><WikiBlockControls editor={editor} editable={editable} /><WikiBubbleMenu editor={editable ? editor : null} />{editable && <AssistMenu editor={editor} workspaceId={workspaceId} />}</div>
    {editable && imageUploads && workItemId && <><input ref={picker} data-testid="description-image-input" hidden type="file" accept="image/png,image/jpeg,image/gif,image/webp" onChange={async (event) => { const file = event.target.files?.[0]; event.target.value = ""; if (!file || !editor) return; const assetId = await uploadFile(file); if (assetId) editor.commands.insertContentAt(editor.state.doc.content.size, { type: "assetImage", attrs: { assetId } }); }} /></>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
