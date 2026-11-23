import { Extension } from "@tiptap/core";
import { Suggestion } from "@tiptap/suggestion";
import { PluginKey } from "@tiptap/pm/state";
import { translate, type MessageKey } from "@weft/shared";
import { action } from "./api";
import { suggestRender } from "./suggest-list";

/**
 * The "[[" picker: a Work item, Project Page or Wiki page the person can open. Picking one inserts the internal link the Written form
 * stores as `[[label|kind:id]]`. The two searches are the ones the command palette uses, so their access checks decide what is listed.
 */

export type ReferenceHit =
  | { kind: "work-item"; id: string; displayId: string; title: string }
  | { kind: "page" | "wiki"; id: string; title: string; projectKey: string | null };

type WorkHit = { id: string; displayId: string; title: string };
type PageHit = { id: string; title: string; projectId: string | null; projectKey: string | null };

/** Rows per kind; the search actions cap their own limits at 100. */
const perKind = 8;
/** search_work_items and search_wiki_pages refuse a query longer than 200 characters. */
const maxQuery = 200;

/** The text the link shows: a Work item reads "MOB-12 Title", a page its title. */
export function referenceLabel(hit: ReferenceHit): string {
  return hit.kind === "work-item" ? `${hit.displayId} ${hit.title}` : hit.title;
}

/** Work items first, then Project Pages, then Wiki pages, so each kind sits under one heading. Each kind keeps the order the search gave. */
export function referenceHits(works: WorkHit[], pages: PageHit[]): ReferenceHit[] {
  const projectPages = pages.filter((row) => row.projectId !== null);
  const wikiPages = pages.filter((row) => row.projectId === null);
  return [
    ...works.map((row): ReferenceHit => ({ kind: "work-item", id: row.id, displayId: row.displayId, title: row.title })),
    ...projectPages.map((row): ReferenceHit => ({ kind: "page", id: row.id, title: row.title, projectKey: row.projectKey })),
    ...wikiPages.map((row): ReferenceHit => ({ kind: "wiki", id: row.id, title: row.title, projectKey: null })),
  ];
}

export function referenceGroup(hit: ReferenceHit): MessageKey {
  return hit.kind === "work-item" ? "reference.groupWorkItems" : hit.kind === "page" ? "reference.groupProjectPages" : "reference.groupWikiPages";
}

/** The place under a row: the key of a Work item, the project of a Project Page, nothing for a Wiki page (its group already says where it is). */
export function referencePlace(hit: ReferenceHit): string | null {
  if (hit.kind === "work-item") return hit.displayId;
  if (hit.kind === "page") return hit.projectKey ? `${translate("palette.inProject")} ${hit.projectKey}` : null;
  return null;
}

/** Runs both searches for the workspace. Null when either fails, so a half-empty list is never shown as a complete one. */
export async function searchReferences(workspaceId: string, query: string): Promise<ReferenceHit[] | null> {
  const text = query.trim().slice(0, maxQuery);
  if (text.length === 0) return [];
  const [works, pages] = await Promise.all([
    action<WorkHit[]>("search_work_items", { workspaceId, query: text, limit: perKind }),
    action<PageHit[]>("search_wiki_pages", { workspaceId, query: text, limit: perKind }),
  ]);
  return works === null || pages === null ? null : referenceHits(works, pages);
}

// Icons are constants; the labels are translated text and go in as text nodes.
const referenceIcon = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const referenceIcons: Record<ReferenceHit["kind"], string> = {
  "work-item": referenceIcon(`<rect x="3" y="3" width="18" height="18" rx="2"/><path d="m9 11 3 3 9-9"/>`),
  page: referenceIcon(`<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z"/><path d="M14 2v5h5M8 13h8M8 17h8"/>`),
  wiki: referenceIcon(`<path d="M2 4h6a4 4 0 0 1 4 4v12a3 3 0 0 0-3-3H2z"/><path d="M22 4h-6a4 4 0 0 0-4 4v12a3 3 0 0 1 3-3h7z"/>`),
};

function referenceContent(hit: ReferenceHit): Node[] {
  const icon = document.createElement("span");
  icon.className = "suggest-option-icon";
  icon.insertAdjacentHTML("beforeend", referenceIcons[hit.kind]);
  const body = document.createElement("span");
  body.className = "suggest-option-body";
  const title = document.createElement("span");
  title.className = "suggest-option-name";
  title.textContent = hit.title;
  body.append(title);
  const place = referencePlace(hit);
  if (place) {
    const line = document.createElement("span");
    line.className = "suggest-option-note";
    line.textContent = place;
    body.append(line);
  }
  return [icon, body];
}

/** Typing "[[" opens the picker; the typed text after it is the search. Escape closes it and keeps what was typed. */
export const ReferencePicker = Extension.create<{ workspaceId: string }>({
  name: "referencePicker",
  addOptions() { return { workspaceId: "" }; },
  addProseMirrorPlugins() {
    const workspaceId = this.options.workspaceId;
    // Only the newest search may set the failed flag; an older one that finishes late is dropped.
    let latest = 0;
    let failed = false;
    const pluginKey = new PluginKey("referencePicker");
    return [Suggestion<ReferenceHit, ReferenceHit>({
      editor: this.editor,
      char: "[[",
      pluginKey,
      // Titles have spaces, so the query runs on past them: "[[dark mode" searches for "dark mode".
      allowSpaces: true,
      allowedPrefixes: null,
      allow: ({ editor }) => editor.isEditable,
      debounce: 200,
      items: async ({ query }) => {
        const ticket = ++latest;
        failed = false;
        const hits = await searchReferences(workspaceId, query);
        if (ticket !== latest) return [];
        failed = hits === null;
        return hits ?? [];
      },
      command: ({ editor, range, props: hit }) => {
        const label = referenceLabel(hit);
        editor.chain().focus().deleteRange(range).insertContent({
          type: "text", text: label,
          marks: [{ type: "link", attrs: { href: `weft://${hit.kind}/${hit.id}`, kind: hit.kind, targetId: hit.id, target: label } }],
        }).run();
      },
      render: suggestRender<ReferenceHit>({
        label: "reference.picker",
        pluginKey,
        group: referenceGroup,
        content: referenceContent,
        notice: (props) => props.loading ? "reference.loading" : failed ? "reference.failed" : props.items.length > 0 ? null : props.query.trim() ? "reference.empty" : "reference.hint",
      }),
    })];
  },
});
