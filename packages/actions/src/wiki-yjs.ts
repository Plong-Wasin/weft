import { getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { prosemirrorJSONToYDoc, yDocToProsemirrorJSON } from "y-prosemirror";
import * as Y from "yjs";

const schema = getSchema([StarterKit]);
export const wikiYFragment = "default";
export function createWikiYDoc(content: unknown) {
  const initial = content && typeof content === "object" ? content : { type: "doc", content: [{ type: "paragraph" }] };
  return prosemirrorJSONToYDoc(schema, initial, wikiYFragment);
}
export function wikiYState(document: Y.Doc) { return Buffer.from(Y.encodeStateAsUpdate(document)); }
export function wikiContentFromYState(state: Uint8Array) {
  const document = new Y.Doc();
  Y.applyUpdate(document, state);
  try { return yDocToProsemirrorJSON(document, wikiYFragment); } finally { document.destroy(); }
}
export function wikiYStateFromContent(content: unknown) {
  const document = createWikiYDoc(content);
  try { return wikiYState(document); } finally { document.destroy(); }
}
