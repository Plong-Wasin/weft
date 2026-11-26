import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { WikiBlockControls } from "../src/wiki-block-controls";

// React can render the controls before <EditorContent> has mounted the editor view; tiptap then throws on view.dom.
test("block controls render before the editor view is mounted", () => {
  const editor = new Editor({ element: null, extensions: [StarterKit], content: { type: "doc", content: [{ type: "paragraph" }] } });
  expect(renderToStaticMarkup(<WikiBlockControls editor={editor} editable />)).toContain("wiki-block-controls");
});
