import { markdownToDoc } from "./markdown-doc";
import { ActionError } from "./members";
import { assertWikiDoc } from "./wiki-yjs";

/**
 * Page content from an AI proposal or any caller: Markdown text becomes the editor's document, a document passes through,
 * and anything else is refused, so a malformed body can never reach the page as an empty editor state.
 */
export function wikiContentOf<T>(content: T): T | ReturnType<typeof markdownToDoc> {
  if (content === undefined) return content;
  if (typeof content === "string") return markdownToDoc(content);
  const doc = content as { type?: unknown; content?: unknown };
  if (typeof content === "object" && content !== null && doc.type === "doc" && (doc.content === undefined || Array.isArray(doc.content))) {
    // The editor's schema decides what a document is: a node it does not know would otherwise fail later as a server error, at confirm time.
    try { assertWikiDoc(content); } catch { throw new ActionError("content is not a valid document", 400); }
    return content;
  }
  throw new ActionError("content must be Markdown text or a Tiptap doc", 400);
}
