import React from "react";
import { useParams } from "react-router";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Mention from "@tiptap/extension-mention";
import { Table } from "@tiptap/extension-table";
import { TableRow } from "@tiptap/extension-table-row";
import { TableCell } from "@tiptap/extension-table-cell";
import { TableHeader } from "@tiptap/extension-table-header";
import { TaskList } from "@tiptap/extension-task-list";
import { TaskItem } from "@tiptap/extension-task-item";
import { Color } from "@tiptap/extension-color";
import { TextStyle } from "@tiptap/extension-text-style";
import { Node } from "@tiptap/core";

const api = import.meta.env.VITE_API_URL ?? "http://localhost:3000";
const Callout = Node.create({ name: "callout", group: "block", content: "block+", defining: true, parseHTML() { return [{ tag: "aside[data-callout]" }]; }, renderHTML() { return ["aside", { "data-callout": "true", class: "wiki-callout" }, 0]; } });

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
  const editor = useEditor({ extensions: [StarterKit.configure({ heading: { levels: [1, 2, 3, 4, 5, 6] } }), Mention, Table, TableRow, TableHeader, TableCell, TaskList, TaskItem.configure({ nested: true }), TextStyle, Color, Callout], content: page?.content ?? "", editable: false });
  React.useEffect(() => { if (editor && page) editor.commands.setContent(page.content); }, [editor, page]);
  if (missing) return <main className="mx-auto max-w-3xl p-8">Published page not found</main>;
  if (!page || !editor) return <main className="mx-auto max-w-3xl p-8">Loading…</main>;
  return <main className="mx-auto max-w-3xl p-8" data-testid="published-wiki-page"><h1 className="mb-6 text-3xl font-semibold">{page.title}</h1><div className="wiki-editor"><EditorContent editor={editor} /></div></main>;
}
