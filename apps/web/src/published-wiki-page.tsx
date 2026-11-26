import { Button } from "@/ui/button";
import React from "react";
import { useParams } from "react-router";
import { EditorContent, useEditor } from "@tiptap/react";
import { translate } from "@weft/shared";
import { EmptyState } from "./empty-state";
import { surfaceEditorExtensions } from "./editor-extensions";

const api = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

type LoadState = "loading" | "missing" | "failed";

/** Only a 404 answer means the page is gone; any other status is a failure worth retrying. */
export function publishedLoadState(status: number): "missing" | "failed" { return status === 404 ? "missing" : "failed"; }

export function PublishedPageStatus({ state, onRetry }: { state: LoadState; onRetry: () => void }) {
  const shell = "grid min-h-screen place-items-center p-8";
  if (state === "loading") return <main className={`${shell} text-muted-foreground`}><p role="status" className="m-0 text-14">{translate("published.loading")}</p></main>;
  if (state === "missing") return <main className={shell}><EmptyState title={translate("published.notFound")} /></main>;
  return <main className={shell}><EmptyState title={translate("published.loadFailed")} action={<Button type="button" className="secondary !min-h-11" onClick={onRetry}>{translate("published.retry")}</Button>} /></main>;
}

export function PublishedWikiPage() {
  const { token = "" } = useParams();
  const [page, setPage] = React.useState<{ title: string; content: object } | null>(null);
  const [failure, setFailure] = React.useState<"missing" | "failed" | null>(null);
  const [attempt, setAttempt] = React.useState(0);
  React.useEffect(() => {
    let active = true;
    setFailure(null);
    void fetch(`${api}/published/${encodeURIComponent(token)}`).then(async (response) => {
      if (!response.ok) { if (active) setFailure(publishedLoadState(response.status)); return; }
      const result = await response.json() as { title: string; content: object };
      if (active) setPage(result);
    }).catch(() => { if (active) setFailure("failed"); });
    return () => { active = false; };
  }, [token, attempt]);
  const editor = useEditor({ extensions: surfaceEditorExtensions({ surface: "full" }), content: page?.content ?? "", editable: false });
  React.useEffect(() => { if (editor && page) editor.commands.setContent(page.content); }, [editor, page]);
  if (failure) return <PublishedPageStatus state={failure} onRetry={() => setAttempt((n) => n + 1)} />;
  if (!page || !editor) return <PublishedPageStatus state="loading" onRetry={() => {}} />;
  return <main className="mx-auto max-w-3xl p-8" data-testid="published-wiki-page"><h1 className="mb-6 text-3xl font-semibold">{page.title}</h1><div className="wiki-editor"><EditorContent editor={editor} /></div></main>;
}
