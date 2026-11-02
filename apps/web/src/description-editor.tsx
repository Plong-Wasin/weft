import React from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { translate } from "@weft/shared";
import { useAssetImages } from "./asset-images";
import { AssistMenu } from "./assist-menu";
import { AiAssist } from "./editor-assist";

/** Work item description: a Tiptap editor that accepts pasted or dropped images, owned by the work item. */
export function DescriptionEditor({ workspaceId, workItemId, initial, editable, onChange }: { workspaceId: string; workItemId: string; initial: unknown; editable: boolean; onChange: (doc: unknown) => void }) {
  const { extension, error } = useAssetImages(editable ? { ownerType: "work_item", ownerId: workItemId } : null);
  const editor = useEditor({
    extensions: [StarterKit, AiAssist, extension], content: (initial as object | null) ?? "", editable,
    onUpdate: ({ editor: current }) => onChange(current.getJSON()),
  });
  return <div>
    <div className="comment-editor relative" data-testid="description-editor"><EditorContent editor={editor} aria-label={translate("workItems.description")} />{editable && <AssistMenu editor={editor} workspaceId={workspaceId} />}</div>
    {error && <p role="alert">{error}</p>}
  </div>;
}
