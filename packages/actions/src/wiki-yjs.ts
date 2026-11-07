import { getSchema } from "@tiptap/core";
import { prosemirrorJSONToYDoc, prosemirrorToYXmlFragment, yDocToProsemirrorJSON } from "y-prosemirror";
import * as Y from "yjs";
import { normalizeAssetImages, wikiEditorExtensions } from "./wiki-editor-extensions";
export { normalizeAssetImages } from "./wiki-editor-extensions";

const schema = getSchema(wikiEditorExtensions);
export const wikiYFragment = "default";
export function createWikiYDoc(content: unknown) {
  const initial = content && typeof content === "object" ? content : { type: "doc", content: [{ type: "paragraph" }] };
  return prosemirrorJSONToYDoc(schema, normalizeAssetImages(initial), wikiYFragment);
}
/** Throws when the JSON is not a document the editor's schema allows: unknown nodes or marks, wrong nesting, bad attributes, or no block at all. */
export function assertWikiDoc(content: unknown) { schema.nodeFromJSON(normalizeAssetImages(content)).check(); }
export function wikiYState(document: Y.Doc) { return Buffer.from(Y.encodeStateAsUpdate(document)); }
export function wikiContentFromYState(state: Uint8Array) {
  const document = new Y.Doc();
  Y.applyUpdate(document, state);
  try { return normalizeAssetImages(yDocToProsemirrorJSON(document, wikiYFragment)); } finally { document.destroy(); }
}
export function wikiYStateFromContent(content: unknown) {
  const document = createWikiYDoc(content);
  try { return wikiYState(document); } finally { document.destroy(); }
}

/** Replaces a live document's content using normal Yjs operations so connected editors receive the write. */
export function replaceWikiYDocContent(document: Y.Doc, content: unknown) {
  const initial = content && typeof content === "object" ? content : { type: "doc", content: [{ type: "paragraph" }] };
  const fragment = document.getXmlFragment(wikiYFragment);
  const node = schema.nodeFromJSON(normalizeAssetImages(initial));
  document.transact(() => {
    if (fragment.length) fragment.delete(0, fragment.length);
    prosemirrorToYXmlFragment(node, fragment);
  });
}
