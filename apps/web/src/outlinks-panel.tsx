import React from "react";
import { Link } from "react-router";
import { translate, type MessageKey } from "@weft/shared";

type Kind = "work-item" | "page" | "wiki";
type Entry = { id: string; kind: Kind; title: string; displayId: string | null; project: string | null; collection: string | null; projectKey?: string | null };
type Run = (name: string, body: unknown) => Promise<Entry[] | null>;
const t = (key: string) => translate(key as MessageKey);

/** Shared Outlinks and Backlinks display for Work items, Pages, and Wiki pages. */
export function OutlinksPanel({ kind, id, run, refreshKey = 0, updating = false, onRefreshComplete }: { kind: Kind; id: string; run: Run; refreshKey?: number; updating?: boolean; onRefreshComplete?: (refreshKey: number) => void }) {
  const [outlinks, setOutlinks] = React.useState<Entry[] | null>(null);
  const [backlinks, setBacklinks] = React.useState<Entry[] | null>(null);
  const [unavailable, setUnavailable] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const [refreshing, setRefreshing] = React.useState(false);
  React.useEffect(() => {
    let active = true;
    if (outlinks !== null || backlinks !== null) setRefreshing(true);
    void Promise.all([
      run("list_outlinks", { kind, id }),
      run("list_backlinks", { kind, id }),
    ]).then(([out, back]) => { if (active) {
      if (kind === "page" && (out === null || back === null)) { setUnavailable(true); setFailed(false); return; }
      setUnavailable(false); setOutlinks(out ?? []); setBacklinks(back ?? []); setFailed(false);
    } })
      .catch(() => { if (active) setFailed(true); })
      .finally(() => { if (active) { setRefreshing(false); onRefreshComplete?.(refreshKey); } });
    return () => { active = false; };
  }, [kind, id, run, refreshKey]);

  if (unavailable) return null;

  const list = (heading: string, entries: Entry[] | null, empty: string) => <div className="grid gap-2">
      <h4 className="m-0 text-13 font-medium text-muted-foreground">{heading}</h4>
      {entries === null ? <p className="m-0 text-13 text-muted-foreground">{updating ? t("outlinks.updating") : t("outlinks.loading")}</p> : entries.length === 0 ? <p className="m-0 text-13 text-muted-foreground">{updating ? t("outlinks.updating") : empty}</p> :
      <ul className="m-0 grid gap-1.5 p-0">{entries.map((entry) => <li key={`${entry.kind}:${entry.id}`} className="list-none rounded border border-border px-3 py-2">
        <Link className="text-13 font-medium text-foreground underline" to={entry.kind === "work-item" ? `/${window.location.pathname.split("/")[1]}/browse/${entry.displayId}` : entry.kind === "wiki" ? `/${window.location.pathname.split("/")[1]}/wiki/${entry.id}` : `/${window.location.pathname.split("/")[1]}/projects/${entry.projectKey}/pages/${entry.id}`}>{entry.displayId ? `${entry.displayId} · ` : ""}{entry.title}</Link>
        <div className="mt-0.5 text-12 text-muted-foreground">{t(`outlinks.kind.${entry.kind}`)} · {entry.project ?? entry.collection ?? t("outlinks.workspace")}</div>
      </li>)}</ul>}
  </div>;

  return <section aria-label={t("outlinks.title")} className="grid min-w-0 max-w-full gap-3 border-t border-border pt-4">
    <div><h3 className="m-0 text-15 font-semibold text-foreground">{t("outlinks.title")}</h3>
      <p className="m-0 mt-1 text-12 text-muted-foreground">{t("outlinks.explanation")}</p></div>
    {(updating || refreshing) && <p role="status" data-testid="outlinks-updating" className="m-0 text-12 text-muted-foreground">{t("outlinks.updating")}</p>}
    {failed && <p role="status" className="m-0 text-13 text-muted-foreground">{t("outlinks.loadFailed")}</p>}
    <div className="grid gap-4 sm:grid-cols-2">
      {list(kind === "work-item" ? t("outlinks.fromWorkItem") : t("outlinks.fromHere"), outlinks, kind === "work-item" ? t("outlinks.emptyWorkItem") : t("outlinks.emptyOut"))}
      {list(t("outlinks.toHere"), backlinks, t("outlinks.emptyBack"))}
    </div>
  </section>;
}
