import { api } from "./api";
import React from "react";
import { translate } from "@weft/shared";
import { Link, useLocation } from "react-router";
import { Search, X } from "lucide-react";
import { paths } from "./routes";

type Result = { id: string; displayId: string; title: string; snippet: string };

type WikiResult = { id: string; title: string; snippet: string };

async function post<T>(name: string, workspaceId: string, query: string): Promise<T[] | null> {
  const response = await fetch(`${api}/actions/${name}`, {
    method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId, query }),
  });
  return response.ok ? await response.json() as T[] : null;
}

async function search(workspaceId: string, query: string): Promise<{ items: Result[]; wiki: WikiResult[] } | null> {
  const [items, wiki] = await Promise.all([post<Result>("search_work_items", workspaceId, query), post<WikiResult>("search_wiki_pages", workspaceId, query)]);
  return items === null ? null : { items, wiki: wiki ?? [] };
}

export function WorkItemSearch({ workspace }: { workspace: { id: string; slug: string } }) {
  const [query, setQuery] = React.useState("");
  const [results, setResults] = React.useState<{ items: Result[]; wiki: WikiResult[] } | null>(null);
  const [failed, setFailed] = React.useState(false);
  const latest = React.useRef(0);
  // Below md the field is an icon button that opens a full-width bar over the top bar.
  const [expanded, setExpanded] = React.useState(false);
  const input = React.useRef<HTMLInputElement>(null);
  const { pathname } = useLocation();
  React.useEffect(() => setExpanded(false), [pathname]);
  React.useEffect(() => { if (expanded) input.current?.focus(); }, [expanded]);

  React.useEffect(() => {
    const text = query.trim();
    if (text.length === 0) { setResults(null); setFailed(false); return; }
    const ticket = ++latest.current;
    const timer = setTimeout(async () => {
      const found = await search(workspace.id, text);
      if (ticket !== latest.current) return;
      setFailed(found === null);
      setResults(found ?? { items: [], wiki: [] });
    }, 250);
    return () => clearTimeout(timer);
  }, [query, workspace.id]);

  return <>
    <button type="button" aria-label={translate("search.label")} aria-expanded={expanded} onClick={() => setExpanded(true)} className="rounded-md bg-transparent p-1.5 text-secondary hover:bg-layer-transparent-hover hover:text-primary md:hidden"><Search aria-hidden size={18} /></button>
    <div role="search" className={`search ${expanded ? "max-md:fixed max-md:inset-x-0 max-md:top-0 max-md:z-40 max-md:flex max-md:h-header max-md:max-w-none max-md:items-center max-md:gap-2 max-md:border-b max-md:border-subtle max-md:bg-surface-1 max-md:px-3" : "max-md:hidden"}`}>
    <div className="relative min-w-0 flex-1">
      <Search aria-hidden size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-tertiary" />
      <input ref={input} type="search" className="w-full pl-8" value={query} placeholder={translate("search.placeholder")} aria-label={translate("search.label")}
        onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") { setQuery(""); setExpanded(false); } }} />
    </div>
    {expanded && <button type="button" aria-label={translate("search.close")} onClick={() => { setQuery(""); setExpanded(false); }} className="rounded-md bg-transparent p-1.5 text-secondary hover:bg-layer-transparent-hover md:hidden"><X aria-hidden size={18} /></button>}
    {results && <ul className="search-results top-full" aria-label={translate("search.results")}>
      {failed && <li role="alert">{translate("search.failed")}</li>}
      {!failed && results.items.length === 0 && results.wiki.length === 0 && <li>{translate("search.empty")}</li>}
      {results.items.map((item) => <li key={item.id}>
        <Link to={paths.workItem(workspace.slug, item.displayId)}><strong>{item.displayId}</strong> {item.title}</Link>
        {item.snippet && <small>{item.snippet}</small>}
      </li>)}
      {results.wiki.length > 0 && <li role="presentation"><strong>{translate("search.wikiHeading")}</strong></li>}
      {results.wiki.map((page) => <li key={page.id}>
        <Link to={paths.wikiPage(workspace.slug, page.id)}>{page.title}</Link>
        {page.snippet && <small>{page.snippet}</small>}
      </li>)}
    </ul>}
  </div>
  </>;
}
