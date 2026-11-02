import React from "react";
import { translate } from "@weft/shared";
import { Copy, ExternalLink, Pencil, Trash2 } from "lucide-react";
import { Dialog, DialogActions } from "./dialog";
import { copyText } from "./toast";
type WebLink = { id: string; url: string; title: string | null };
const t = (key: string) => translate(key as never);
const rowButton = "grid size-7 place-items-center rounded-md !bg-transparent !p-0 text-secondary hover:!bg-layer-transparent-hover hover:text-primary";

/** One form for both adding and editing a Web Link; `link` is set when editing. */
function LinkDialog({ link, onSubmit, onClose }: { link: WebLink | null; onSubmit: (url: string, title: string | null) => Promise<boolean>; onClose: () => void }) {
  const [url, setUrl] = React.useState(link?.url ?? "");
  const [title, setTitle] = React.useState(link?.title ?? "");
  const busy = React.useRef(false);
  return <Dialog title={link ? t("webLinks.editTitle") : t("webLinks.addTitle")} onClose={onClose}>
    <form className="grid gap-3" onSubmit={async (event) => {
      event.preventDefault();
      if (busy.current) return;
      busy.current = true;
      try { if (await onSubmit(url, title.trim() || null)) onClose(); } finally { busy.current = false; }
    }}>
      <label className="grid gap-1 text-13 text-secondary">{t("webLinks.urlLabel")}<input type="url" required pattern="https?://.*" placeholder={t("webLinks.url")} value={url} onChange={(event) => setUrl(event.target.value)} /></label>
      <label className="grid gap-1 text-13 text-secondary">{t("webLinks.titleOptional")}<input value={title} onChange={(event) => setTitle(event.target.value)} /></label>
      <DialogActions onClose={onClose} submit={link ? t("webLinks.save") : t("webLinks.add")} />
    </form>
  </Dialog>;
}

export function WebLinksPanel({ workItemId, canWrite, action, onChange, showForm, onClose, onCount }: { workItemId: string; canWrite: boolean; action: <T = unknown>(name: string, input: Record<string, unknown>) => Promise<T | null>; onChange: () => void; showForm: boolean; onClose: () => void; onCount: (count: number) => void }) {
  const [rows, setRows] = React.useState<WebLink[]>([]);
  const [editing, setEditing] = React.useState<WebLink | null>(null);
  const [note, setNote] = React.useState<string | null>(null);
  const load = React.useCallback(async () => setRows(await action<WebLink[]>("list_web_links", { workItemId }) ?? []), [action, workItemId]);
  React.useEffect(() => { void load(); }, [load]);
  React.useEffect(() => { onCount(rows.length); }, [onCount, rows.length]);
  const done = async (result: unknown) => { setNote(result === null ? t("webLinks.failed") : null); await load(); onChange(); return result !== null; };
  const host = (value: string) => { try { return new URL(value).host; } catch { return value; } };
  const close = () => { setEditing(null); onClose(); };
  return <section>
    {rows.length > 0 && <ul className="m-0 grid list-none gap-1.5 !pl-0">{rows.map((row) => <li key={row.id} className="flex items-center gap-2 rounded-md bg-layer-1 px-2.5 py-1.5 text-13">
      <ExternalLink aria-hidden size={13} className="shrink-0 text-tertiary" />
      <a href={row.url} target="_blank" rel="noreferrer" className="min-w-0 truncate text-primary hover:underline" title={row.url}>{row.title || host(row.url)}</a>
      {row.title && <span className="min-w-0 shrink truncate text-tertiary">{host(row.url)}</span>}
      <span className="ml-auto flex shrink-0 gap-0.5">
        <button type="button" className={rowButton} aria-label={t("webLinks.copy")} title={t("webLinks.copy")} onClick={() => void copyText(row.url, t("webLinks.copied"), t("comments.copyFailed"))}><Copy aria-hidden size={13} /></button>
        {canWrite && <>
          <button type="button" className={rowButton} aria-label={t("webLinks.edit")} title={t("webLinks.edit")} onClick={() => setEditing(row)}><Pencil aria-hidden size={13} /></button>
          <button type="button" className={`${rowButton} hover:!text-danger-text`} aria-label={t("webLinks.remove")} title={t("webLinks.remove")} onClick={async () => { await done(await action("delete_web_link", { webLinkId: row.id })); }}><Trash2 aria-hidden size={13} /></button>
        </>}
      </span>
    </li>)}</ul>}
    {canWrite && (showForm || editing) && <LinkDialog key={editing?.id ?? "new"} link={editing} onClose={close}
      onSubmit={(url, title) => editing ? action("update_web_link", { webLinkId: editing.id, url, title }).then(done) : action("create_web_link", { workItemId, url, title }).then(done)} />}
    {note && <p role="alert">{note}</p>}
  </section>;
}
