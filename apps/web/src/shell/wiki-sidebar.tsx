import React from "react";
import { NavLink, useLocation, useNavigate } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, ChevronRight, FileText, Folder, GripVertical, Lock, Plus, Users } from "lucide-react";
import { translate } from "@weft/shared";
import { action, actionResult } from "../api";
import { wikiDropDecision } from "../wiki-drop-target";
import { paths } from "../routes";
import type { Workspace } from "../types";

type PageRow = { id: string; title: string; parentId: string | null; collectionId?: string | null; projectId?: string | null; access: "public" | "private"; ownerId: string; archived: boolean; canEdit: boolean; canMoveAcrossCollections: boolean };
type Collection = { id: string; name: string; icon: string; visibility: "public" | "private"; isDefault: boolean };

const row = (active: boolean) => `flex min-w-0 items-center gap-2 rounded-md px-2 py-1 text-13 ${active ? "bg-layer-1-selected font-medium text-primary" : "text-secondary hover:bg-layer-transparent-hover hover:text-primary"}`;
const heading = "flex w-full items-center gap-1 rounded-md !bg-transparent px-2 py-1 text-left text-12 font-medium text-tertiary hover:!bg-layer-transparent-hover";

/** Pages of one level, each with its children below it when it is open; the path to the open page is always open. */
function PageTree({ workspace, pages, parentId, activeId, open, toggle, depth, dragging, over, dragStart, overKind }: { workspace: Workspace; pages: PageRow[]; parentId: string | null; activeId: string; open: Set<string>; toggle: (id: string) => void; depth: number; dragging: string | null; over: string | null; dragStart: (id: string, event: React.PointerEvent) => void; overKind: string | null }) {
  const known = new Set(pages.map((page) => page.id));
  const level = pages.filter((page) => parentId === null ? page.parentId === null || !known.has(page.parentId) : page.parentId === parentId);
  return <ul className="m-0 grid list-none gap-0.5 p-0">{level.map((page) => {
    const children = pages.filter((child) => child.parentId === page.id);
    const expanded = open.has(page.id);
    return <li key={page.id}>
      <div data-wiki-drop-id={`page:${page.id}`} className={`flex items-center ${over === `page:${page.id}` ? "rounded-md bg-accent-primary/15 ring-1 ring-accent-primary" : ""} ${dragging === page.id ? "opacity-50" : ""}`} style={{ paddingLeft: `${depth * 0.75}rem` }}>
        {children.length > 0
          ? <button type="button" aria-expanded={expanded} aria-label={`${translate("wikiSidebar.toggle")}: ${page.title}`} onClick={() => toggle(page.id)} className="grid size-5 shrink-0 place-items-center rounded !bg-transparent !p-0 text-tertiary hover:!bg-layer-transparent-hover"><ChevronRight aria-hidden size={12} className={`transition-transform ${expanded ? "rotate-90" : ""}`} /></button>
          : <span className="size-5 shrink-0" />}
        <NavLink to={paths.wikiPage(workspace.slug, page.id)} className={({ isActive }) => `${row(isActive)} flex-1`}><FileText aria-hidden size={13} className="shrink-0" /><span className="truncate">{page.title}</span></NavLink>
        {over === `page:${page.id}` && <span className="px-1 text-11 font-medium text-accent-primary">{translate(overKind === "nest" ? "wikiSidebar.dropNest" : "wikiSidebar.dropTopLevel")}</span>}
        {page.canEdit && <button type="button" aria-label={`${translate("sortable.reorder")}: ${page.title}`} data-wiki-drag-handle={page.id} onPointerDown={(event) => dragStart(page.id, event)} className="grid size-5 shrink-0 touch-none place-items-center rounded !bg-transparent !p-0 text-tertiary hover:!bg-layer-transparent-hover hover:text-primary cursor-grab"><GripVertical aria-hidden size={12} /></button>}
      </div>
      {expanded && children.length > 0 && <PageTree workspace={workspace} pages={pages} parentId={page.id} activeId={activeId} open={open} toggle={toggle} depth={depth + 1} dragging={dragging} over={over} dragStart={dragStart} overKind={overKind} />}
    </li>;
  })}</ul>;
}

function Group({ label, icon, count, defaultOpen, holdsActive = false, dropHint, children }: { label: string; icon: React.ReactNode; count?: number; defaultOpen: boolean; holdsActive?: boolean; dropHint?: string; children: React.ReactNode }) {
  const [open, setOpen] = React.useState(defaultOpen || holdsActive);
  // Landing on a page opens the group it lives in, even when the pages arrive after the first render.
  React.useEffect(() => { if (holdsActive) setOpen(true); }, [holdsActive]);
  return <section className="grid gap-0.5">
    <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className={heading}>
      <ChevronRight aria-hidden size={12} className={`transition-transform ${open ? "rotate-90" : ""}`} />{icon}<span className="flex-1 truncate">{label}</span>{dropHint && <span className="text-11 font-medium text-accent-primary">{dropHint}</span>}{count !== undefined && <span className="font-normal">{count}</span>}
    </button>
    {open && <div className="grid gap-0.5 pl-1">{children}</div>}
  </section>;
}

/** The Wiki sidebar: new page, the pages of every Collection as a tree, then Shared, Private and Archives. */
export function WikiSidebar({ workspace, selfId }: { workspace: Workspace; selfId: string }) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const client = useQueryClient();
  const activeId = pathname.split("/")[3] ?? "";
  const { data: pages = [] } = useQuery({ queryKey: ["wiki-pages", workspace.id, "sidebar"], queryFn: async () => await action<PageRow[]>("list_wiki_pages", { workspaceId: workspace.id, archived: false }) ?? [] });
  const { data: shared = [] } = useQuery({ queryKey: ["wiki-pages", workspace.id, "shared"], queryFn: async () => await action<PageRow[]>("list_shared_wiki_pages", { workspaceId: workspace.id }) ?? [] });
  const { data: collections = [] } = useQuery({ queryKey: ["wiki-collections", workspace.id], queryFn: async () => await action<Collection[]>("list_collections", { workspaceId: workspace.id }) ?? [] });
  const [open, setOpen] = React.useState<Set<string>>(new Set());
  const [dragging, setDragging] = React.useState<string | null>(null);
  const [over, setOverState] = React.useState<string | null>(null);
  const [overKind, setOverKind] = React.useState<string | null>(null);
  const overRef = React.useRef<string | null>(null);
  const setOver = (value: string | null, kind: string | null = null) => { overRef.current = value; setOverState(value); setOverKind(kind); };
  const [dropMessage, setDropMessage] = React.useState("");
  const toggle = (id: string) => setOpen((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  // Opening a page opens everything above it, so the tree always shows where you are.
  React.useEffect(() => {
    const byId = new Map(pages.map((page) => [page.id, page]));
    const path: string[] = [];
    for (let at = byId.get(activeId)?.parentId; at && byId.has(at) && !path.includes(at); at = byId.get(at)?.parentId) path.push(at);
    if (path.length) setOpen((current) => path.every((id) => current.has(id)) ? current : new Set([...current, ...path]));
  }, [activeId, pages]);
  const workspacePages = pages.filter((page) => !page.projectId);
  const mine = workspacePages.filter((page) => page.access === "private" && page.ownerId === selfId);
  const isMine = new Set(mine.map((page) => page.id));
  const create = async () => {
    const created = await action<{ id: string }>("create_wiki_page", { workspaceId: workspace.id, title: translate("wiki.untitled") });
    if (created) { await client.invalidateQueries({ queryKey: ["wiki-pages", workspace.id] }); navigate(paths.wikiPage(workspace.slug, created.id)); }
  };
  const tree = (list: PageRow[]) => <PageTree workspace={workspace} pages={list} parentId={null} activeId={activeId} open={open} toggle={toggle} depth={0} dragging={dragging} over={over} dragStart={startDrag} overKind={overKind} />;
  const defaultCollectionId = collections.find((item) => item.isDefault)?.id ?? "";
  const pageCollection = (page: PageRow) => page.collectionId ?? defaultCollectionId;
  const startDrag = (id: string, event: React.PointerEvent) => { if (event.button !== 0) return; event.currentTarget.setPointerCapture(event.pointerId); setDragging(id); };
  const moveDrag = (event: React.PointerEvent) => {
    if (!dragging) return;
    const rawTarget = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-wiki-drop-id]")?.dataset.wikiDropId ?? null;
    const source = workspacePages.find((page) => page.id === dragging);
    if (!rawTarget || !source) { setOver(null); return; }
    const descendants = new Set<string>();
    let changed = true;
    while (changed) { changed = false; for (const page of workspacePages) if (page.parentId === dragging || descendants.has(page.parentId ?? "")) { if (!descendants.has(page.id)) { descendants.add(page.id); changed = true; } } }
    const [kind, id] = rawTarget.split(":", 2);
    const target = kind === "collection" ? { id: id!, collectionId: id!, header: true as const } : (() => { const page = workspacePages.find((item) => item.id === id); return page ? { id: page.id, collectionId: pageCollection(page), parentId: page.parentId, descendants: new Set<string>(), canEdit: page.canEdit } : null; })();
    const decision = target && wikiDropDecision({ id: source.id, collectionId: pageCollection(source), parentId: source.parentId, descendants, canEdit: source.canEdit }, target, source.ownerId === selfId || source.canMoveAcrossCollections);
    setOver(decision ? rawTarget : null, decision ? decision.kind : null);
  };
  const endDrag = async () => {
    if (!dragging) return;
    const source = workspacePages.find((page) => page.id === dragging);
    const rawTarget = overRef.current;
    setDragging(null); setOver(null);
    if (!source || !rawTarget) return;
    const descendants = new Set<string>();
    let changed = true;
    while (changed) { changed = false; for (const page of workspacePages) if (page.parentId === dragging || descendants.has(page.parentId ?? "")) { if (!descendants.has(page.id)) { descendants.add(page.id); changed = true; } } }
    const [kind, targetId] = rawTarget.split(":", 2);
    const collection = collections.find((item) => item.id === (kind === "collection" ? targetId : (() => { const found = workspacePages.find((item) => item.id === targetId); return found ? pageCollection(found) : undefined; })()));
    if (!collection) return;
    const decision = wikiDropDecision({ id: source.id, collectionId: pageCollection(source), parentId: source.parentId, descendants, canEdit: source.canEdit }, kind === "collection" ? { id: targetId!, collectionId: targetId!, header: true } : (() => { const target = workspacePages.find((item) => item.id === targetId); return target ? { id: target.id, collectionId: pageCollection(target), parentId: target.parentId, descendants: new Set<string>(), canEdit: target.canEdit } : { id: "", collectionId: "", parentId: null, descendants: new Set<string>(), canEdit: false }; })(), source.ownerId === selfId || source.canMoveAcrossCollections);
    if (!decision) return;
    let ok = false;
    if (decision.kind === "move-collection") {
      const impact = await actionResult<{ pageCount: number; shareCount: number; publishedLink: boolean; workItemLinkCount: number }>("get_page_move_impact", { pageId: source.id, projectId: null, collectionId: decision.collectionId });
      if ("error" in impact) { setDropMessage(impact.error); return; }
      const value = impact.data;
      const confirmText = `Move ${value.pageCount} page${value.pageCount === 1 ? "" : "s"}? This removes ${value.shareCount} page share${value.shareCount === 1 ? "" : "s"}, ${value.publishedLink ? "the published link" : "no published link"}, and ${value.workItemLinkCount} work-item link${value.workItemLinkCount === 1 ? "" : "s"}. Continue?`;
      if (!window.confirm(confirmText)) return;
      const result = await actionResult("move_page_scope", { pageId: source.id, projectId: null, collectionId: decision.collectionId });
      if ("error" in result) { setDropMessage(result.error); return; } ok = true;
    } else {
      const result = await actionResult("move_wiki_page", { pageId: source.id, parentId: decision.parentId });
      if ("error" in result) { setDropMessage(result.error); return; } ok = true;
    }
    if (ok) { setDropMessage(""); await client.invalidateQueries({ queryKey: ["wiki-pages", workspace.id] }); }
  };
  React.useEffect(() => {
    if (!dragging) return;
    const move = (event: PointerEvent) => moveDrag(event as unknown as React.PointerEvent);
    const end = () => { void endDrag(); };
    const onEscape = (event: KeyboardEvent) => { if (event.key === "Escape") { window.removeEventListener("pointerup", end); window.removeEventListener("pointercancel", end); setDragging(null); setOver(null); } };
    window.addEventListener("keydown", onEscape);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end, { once: true });
    window.addEventListener("pointercancel", end, { once: true });
    return () => { window.removeEventListener("keydown", onEscape); window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end); window.removeEventListener("pointercancel", end); };
  }, [dragging, over, pages]);
  return <>
    <button type="button" onClick={() => void create()} className="mb-1 flex w-full items-center justify-center gap-1.5"><Plus aria-hidden size={14} />{translate("wiki.new")}</button>
    <NavLink end to={paths.wiki(workspace.slug)} className={({ isActive }) => row(isActive)}>{translate("sidebar.allPages")}</NavLink>
    <p className="px-2 pb-0.5 pt-3 text-12 font-medium text-tertiary">{translate("wikiSidebar.collections")}</p>
    {dropMessage && <p role="alert" className="px-2 text-12 text-danger">{dropMessage}</p>}
    {collections.map((collection) => {
      const inCollection = workspacePages.filter((page) => !isMine.has(page.id)).filter((page) => collection.isDefault ? !page.collectionId || page.collectionId === collection.id : page.collectionId === collection.id);
      return <div key={collection.id} data-wiki-drop-id={`collection:${collection.id}`} className={over === `collection:${collection.id}` ? "rounded-md bg-accent-primary/15 ring-1 ring-accent-primary" : ""}><Group label={collection.name} icon={collection.visibility === "private" ? <Lock aria-hidden size={12} /> : <Folder aria-hidden size={12} />} count={inCollection.length} defaultOpen={collection.isDefault} holdsActive={inCollection.some((page) => page.id === activeId)} dropHint={over === `collection:${collection.id}` ? translate("wikiSidebar.dropTopLevel") : undefined}>
        {inCollection.length === 0 ? <p className="m-0 px-2 py-1 text-12 text-tertiary">{translate("wikiSidebar.emptyCollection")}</p> : tree(inCollection)}
      </Group></div>;
    })}
    {shared.length > 0 && <Group label={translate("pages.tab.shared")} icon={<Users aria-hidden size={12} />} count={shared.length} defaultOpen={false} holdsActive={shared.some((page) => page.id === activeId)}>{tree(shared)}</Group>}
    {mine.length > 0 && <Group label={translate("pages.tab.private")} icon={<Lock aria-hidden size={12} />} count={mine.length} defaultOpen={false} holdsActive={isMine.has(activeId)}>{tree(mine)}</Group>}
    <NavLink to={`${paths.wiki(workspace.slug)}?tab=archived`} className={() => `${row(false)} mt-1`}><Archive aria-hidden size={13} />{translate("pages.tab.archived")}</NavLink>
  </>;
}
