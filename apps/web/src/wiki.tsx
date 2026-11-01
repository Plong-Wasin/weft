import { Sidecar } from "./sidecar";
import React from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { formatDate, translate } from "@weft/shared";
import { useAssetImages } from "./asset-images";
import { Link } from "react-router";
import { paths } from "./routes";
import { useNavigate } from "react-router";

const api = import.meta.env.VITE_API_URL ?? "http://localhost:3000";
const heartbeatMs = 20_000;
const autosaveMs = 1_500;

type Summary = { id: string; parentId: string | null; title: string; access: "public" | "private"; ownerId: string };
type Lock = { userId: string; name: string } | null;
type Page = Summary & { content: unknown; lock: Lock };
type Version = { id: string; title: string; createdAt: string };

async function call<T>(name: string, body: unknown): Promise<T | null> {
  const response = await fetch(`${api}/actions/${name}`, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return response.ok ? await response.json() as T : null;
}

function Tree({ pages, parentId, workspaceSlug, selected, depth = 0 }: { pages: Summary[]; parentId: string | null; workspaceSlug: string; selected: string; depth?: number }) {
  // A page whose parent is not in the list (hidden or gone) is shown at the top rather than dropped.
  const known = new Set(pages.map((page) => page.id));
  return <ul style={{ listStyle: "none", paddingLeft: depth === 0 ? 0 : "1rem" }}>
    {pages.filter((page) => parentId === null ? page.parentId === null || !known.has(page.parentId) : page.parentId === parentId).map((page) => <li key={page.id}>
      <Link to={paths.wikiPage(workspaceSlug, page.id)} aria-current={page.id === selected ? "page" : undefined}>{page.title}</Link>
      {page.access === "private" && <small> 🔒</small>}
      <Tree pages={pages} parentId={page.id} workspaceSlug={workspaceSlug} selected={selected} depth={depth + 1} />
    </li>)}
  </ul>;
}

function Editor({ page, self, onChanged }: { page: Page; self: string; onChanged: () => void }) {
  const [lock, setLock] = React.useState<Lock>(page.lock);
  const [title, setTitle] = React.useState(page.title);
  const [status, setStatus] = React.useState<"saved" | "saving" | "failed">("saved");
  const [versions, setVersions] = React.useState<Version[]>([]);
  const mine = lock === null || lock.userId === self;
  const dirty = React.useRef<{ title?: string; content?: unknown }>({});
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const { extension: images, error: imageError } = useAssetImages({ ownerType: "wiki_page", ownerId: page.id });
  const editor = useEditor({
    extensions: [StarterKit, images], content: (page.content as object | null) ?? "", editable: lock === null || lock.userId === self,
    onUpdate: ({ editor: current }) => { dirty.current.content = current.getJSON(); schedule(); },
  });

  function schedule() {
    setStatus("saving");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), autosaveMs);
  }
  async function flush() {
    const pending = dirty.current; dirty.current = {};
    if (pending.title === undefined && pending.content === undefined) return;
    const saved = await call<Page>("update_wiki_page", { pageId: page.id, ...pending });
    if (saved) { setLock(saved.lock); setStatus("saved"); } else { dirty.current = { ...pending, ...dirty.current }; setStatus("failed"); }
  }
  async function loadVersions() { setVersions(await call<Version[]>("list_wiki_page_versions", { pageId: page.id }) ?? []); }

  React.useEffect(() => { editor?.setEditable(mine); }, [mine, editor]);
  React.useEffect(() => {
    void loadVersions();
    // Heartbeat keeps our lock alive while open and shows who else is editing.
    const beat = async () => {
      const result = await call<Page>("acquire_wiki_lock", { pageId: page.id });
      if (result) setLock(result.lock);
      else { const current = await call<Page>("get_wiki_page", { pageId: page.id }); if (current) setLock(current.lock); }
    };
    void beat();
    const interval = setInterval(() => void beat(), heartbeatMs);
    const release = () => { void fetch(`${api}/actions/release_wiki_lock`, { method: "POST", credentials: "include", keepalive: true, headers: { "content-type": "application/json" }, body: JSON.stringify({ pageId: page.id }) }); };
    window.addEventListener("pagehide", release);
    return () => { clearInterval(interval); clearTimeout(timer.current); window.removeEventListener("pagehide", release); void flush().finally(release); };
  }, [page.id]);

  async function takeOver() { const result = await call<Page>("acquire_wiki_lock", { pageId: page.id, takeover: true }); if (result) setLock(result.lock); }
  async function restore(versionId: string) {
    const restored = await call<Page & { contentText: string }>("restore_wiki_page_version", { pageId: page.id, versionId });
    if (restored) { setTitle(restored.title); editor?.commands.setContent((restored.content as object | null) ?? ""); await loadVersions(); onChanged(); }
  }

  return <section aria-label={title}>
    <input aria-label={translate("wiki.untitled")} value={title} disabled={!mine} onChange={(event) => { setTitle(event.target.value); dirty.current.title = event.target.value || translate("wiki.untitled"); schedule(); }} onBlur={onChanged} />
    <small role="status">{translate(status === "saved" ? "wiki.saved" : status === "saving" ? "wiki.saving" : "wiki.saveFailed")}</small>
    {!mine && lock && <p role="status">{translate("wiki.editingBy").replace("{name}", lock.name)} {translate("wiki.readOnly")} <button className="secondary" onClick={() => void takeOver()}>{translate("wiki.takeOver")}</button></p>}
    <EditorContent editor={editor} />
    {imageError && <p role="alert">{imageError}</p>}
    <details onToggle={() => void loadVersions()}><summary>{translate("wiki.history")}</summary>
      <ul>{versions.map((version) => <li key={version.id}>{formatDate(version.createdAt)} — {version.title} <button className="secondary" disabled={!mine} onClick={() => void restore(version.id)}>{translate("wiki.restore")}</button></li>)}</ul>
    </details>
  </section>;
}

export function WikiPanel({ workspace, self, pageId }: { workspace: { id: string; slug: string }; self: string; pageId: string }) {
  const navigate = useNavigate();
  const [pages, setPages] = React.useState<Summary[]>([]);
  const [page, setPage] = React.useState<Page | null | undefined>(pageId ? undefined : null);
  const [failed, setFailed] = React.useState(false);

  const reload = React.useCallback(async () => setPages(await call<Summary[]>("list_wiki_pages", { workspaceId: workspace.id }) ?? []), [workspace.id]);
  React.useEffect(() => { void reload(); }, [reload]);
  React.useEffect(() => { if (pageId) void call<Page>("get_wiki_page", { pageId }).then(setPage); else setPage(null); }, [pageId]);

  async function create(parentId: string | null) {
    const created = await call<Page>("create_wiki_page", { workspaceId: workspace.id, title: translate("wiki.untitled"), parentId });
    if (created) navigate(paths.wikiPage(workspace.slug, created.id)); else setFailed(true);
  }
  async function change(name: string, body: Record<string, unknown>) {
    const result = await call(name, { pageId, ...body });
    setFailed(result === null);
    await reload();
    if (name === "set_wiki_page_access" && page) setPage({ ...page, access: body.access as Summary["access"] });
    if (name === "move_wiki_page" && page) setPage({ ...page, parentId: body.parentId as string | null });
    if (name === "delete_wiki_page" && result) navigate(paths.wiki(workspace.slug));
  }

  return <section aria-label={translate("wiki.title")}>
    <h2>{translate("wiki.title")}</h2>
    <button onClick={() => void create(null)}>{translate("wiki.new")}</button>
    {pages.length === 0 ? <p>{translate("wiki.empty")}</p> : <Tree pages={pages} parentId={null} workspaceSlug={workspace.slug} selected={pageId} />}
    {failed && <p role="alert">{translate("wiki.failed")}</p>}
    {pageId && page === null && <p role="alert">{translate("wiki.notFound")}</p>}
    {page && <>
      <Sidecar workspace={workspace} context={{ type: "wiki_page", id: page.id, title: page.title }} />
      <Editor key={page.id} page={page} self={self} onChanged={() => void reload()} />
      <div>
        <label>{translate("wiki.access")}
          <select value={page.access} disabled={page.ownerId !== self} onChange={(event) => void change("set_wiki_page_access", { access: event.target.value })}>
            <option value="public">{translate("wiki.access.public")}</option><option value="private">{translate("wiki.access.private")}</option>
          </select></label>
        <label>{translate("wiki.parent")}
          <select value={page.parentId ?? ""} onChange={(event) => void change("move_wiki_page", { parentId: event.target.value || null })}>
            <option value="">{translate("wiki.noParent")}</option>
            {pages.filter((other) => other.id !== page.id).map((other) => <option key={other.id} value={other.id}>{other.title}</option>)}
          </select></label>
        <button className="secondary" onClick={() => void create(page.id)}>{translate("wiki.newChild")}</button>
        <button className="secondary" onClick={() => void change("delete_wiki_page", {})}>{translate("wiki.delete")}</button>
      </div>
    </>}
  </section>;
}
