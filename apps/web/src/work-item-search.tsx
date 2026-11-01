import React from "react";
import { translate } from "@weft/shared";

const api = import.meta.env.VITE_API_URL ?? "http://localhost:3000";
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

  return <div role="search" className="search">
    <input type="search" value={query} placeholder={translate("search.placeholder")} aria-label={translate("search.label")}
      onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") setQuery(""); }} />
    {results && <ul className="search-results" aria-label={translate("search.results")}>
      {failed && <li role="alert">{translate("search.failed")}</li>}
      {!failed && results.items.length === 0 && results.wiki.length === 0 && <li>{translate("search.empty")}</li>}
      {results.items.map((item) => <li key={item.id}>
        <a href={`/${workspace.slug}/work-items/${item.displayId}`}><strong>{item.displayId}</strong> {item.title}</a>
        {item.snippet && <small>{item.snippet}</small>}
      </li>)}
      {results.wiki.length > 0 && <li role="presentation"><strong>{translate("search.wikiHeading")}</strong></li>}
      {results.wiki.map((page) => <li key={page.id}>
        <a href={`/${workspace.slug}/wiki/${page.id}`}>{page.title}</a>
        {page.snippet && <small>{page.snippet}</small>}
      </li>)}
    </ul>}
  </div>;
}
