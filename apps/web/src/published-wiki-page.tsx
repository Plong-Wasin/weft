import React from "react";
import { useParams } from "react-router";
import { EditorContent, useEditor } from "@tiptap/react";
import { wikiEditorExtensions } from "../../../packages/actions/src/wiki-editor-extensions";

const api = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

export function PublishedWikiPage() {
  const { token = "" } = useParams();
  const [page, setPage] = React.useState<{ title: string; content: object } | null>(null);
  const [missing, setMissing] = React.useState(false);
  React.useEffect(() => {
    let active = true;
    void fetch(`${api}/published/${encodeURIComponent(token)}`).then(async (response) => {
      if (!response.ok) throw new Error("missing");
      return await response.json() as { title: string; content: object };
    }).then((result) => { if (active) setPage(result); }).catch(() => { if (active) setMissing(true); });
    return () => { active = false; };
  }, [token]);
  const editor = useEditor({ extensions: wikiEditorExtensions, content: page?.content ?? "", editable: false });
  React.useEffect(() => { if (editor && page) editor.commands.setContent(page.content); }, [editor, page]);
  if (missing) return <main className="mx-auto max-w-3xl p-8">Published page not found</main>;
  if (!page || !editor) return <main className="mx-auto max-w-3xl p-8">Loading…</main>;
  return <main className="mx-auto max-w-3xl p-8" data-testid="published-wiki-page"><h1 className="mb-6 text-3xl font-semibold">{page.title}</h1><div className="wiki-editor"><EditorContent editor={editor} /></div></main>;
}
