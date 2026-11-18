import { api } from "./api";

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;
export type FilterQueryScope = { workspaceId?: string; projectId?: string };
export type FilterQueryGeneration = { query: string } | { error: string };

/** Calls POST /api/ai/filter-query. The query it returns has already compiled on the server; the caller still shows it for review and applies it only when the user says so. */
export async function requestFilterQuery(scope: FilterQueryScope, request: string, fetcher: Fetcher = (input, init) => fetch(input, init)): Promise<FilterQueryGeneration> {
  try {
    const response = await fetcher(`${api}/api/ai/filter-query`, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...scope, request }) });
    const data = await response.json().catch(() => null) as { query?: unknown; error?: unknown } | null;
    if (response.ok && typeof data?.query === "string" && data.query !== "") return { query: data.query };
    return { error: typeof data?.error === "string" ? data.error : "" };
  } catch {
    return { error: "" };
  }
}
