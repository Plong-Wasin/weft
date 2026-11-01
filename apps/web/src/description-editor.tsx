import React from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { translate } from "@weft/shared";
import { useAssetImages } from "./asset-images";

/** Work item description: a Tiptap editor that accepts pasted or dropped images, owned by the work item. */
export function DescriptionEditor({ workItemId, initial, editable, onChange }: { workItemId: string; initial: unknown; editable: boolean; onChange: (doc: unknown) => void }) {
  const { extension, error } = useAssetImages(editable ? { ownerType: "work_item", ownerId: workItemId } : null);
  const editor = useEditor({
    extensions: [StarterKit, extension], content: (initial as object | null) ?? "", editable,
    onUpdate: ({ editor: current }) => onChange(current.getJSON()),
  });
  return <div>
    <div className="comment-editor" data-testid="description-editor"><EditorContent editor={editor} aria-label={translate("workItems.description")} /></div>
    {error && <p role="alert">{error}</p>}
  </div>;
}
