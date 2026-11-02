import React from "react";
import { translate } from "@weft/shared";
type WebLink = { id: string; url: string; title: string | null };
const t = (key: string) => translate(key as never);
export function WebLinksPanel({ workItemId, canWrite, action, onChange, showForm, onCount }: { workItemId: string; canWrite: boolean; action: <T = unknown>(name: string, input: Record<string, unknown>) => Promise<T | null>; onChange: () => void; showForm: boolean; onCount: (count: number) => void }) {
  const [rows, setRows] = React.useState<WebLink[]>([]); const [url, setUrl] = React.useState(""); const [title, setTitle] = React.useState(""); const [note, setNote] = React.useState<string | null>(null);
  const load = React.useCallback(async () => setRows(await action<WebLink[]>("list_web_links", { workItemId }) ?? []), [action, workItemId]); React.useEffect(() => { void load(); }, [load]);
  React.useEffect(() => { onCount(rows.length); }, [onCount, rows.length]);
  const busy = React.useRef(false);
  const done = async (result: unknown) => { setNote(result === null ? t("webLinks.failed") : null); await load(); onChange(); };
  const host = (value: string) => { try { return new URL(value).host; } catch { return value; } };
  return <section>
    {rows.length > 0 && <ul>{rows.map((row) => <li key={row.id} className="flex flex-wrap items-center gap-2 py-1 text-13">
      <a href={row.url} target="_blank" rel="noreferrer" className="text-primary">{row.title || host(row.url)}</a>{row.title && <span className="text-tertiary">{host(row.url)}</span>}
      {canWrite && <><button type="button" className="secondary" onClick={async () => { const nextUrl = window.prompt(t("webLinks.url"), row.url); if (nextUrl === null) return; const nextTitle = window.prompt(t("webLinks.titleField"), row.title ?? ""); if (nextTitle !== null) await done(await action("update_web_link", { webLinkId: row.id, url: nextUrl, title: nextTitle || null })); }}>{t("webLinks.edit")}</button><button type="button" className="secondary" onClick={async () => done(await action("delete_web_link", { webLinkId: row.id }))}>{t("webLinks.remove")}</button></>}
    </li>)}</ul>}
    {canWrite && showForm && <form onSubmit={async (event) => { event.preventDefault(); if (busy.current) return; busy.current = true; try { const result = await action("create_web_link", { workItemId, url, title: title || null }); await done(result); if (result !== null) { setUrl(""); setTitle(""); } } finally { busy.current = false; } }}><input type="url" required pattern="https?://.*" aria-label={t("webLinks.url")} placeholder={t("webLinks.url")} value={url} onChange={(event) => setUrl(event.target.value)} /><input aria-label={t("webLinks.titleField")} placeholder={t("webLinks.titleOptional")} value={title} onChange={(event) => setTitle(event.target.value)} /><button>{t("webLinks.add")}</button></form>}
    {note && <p role="alert">{note}</p>}
  </section>;
}
