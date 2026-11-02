/** Base URL of the API. An empty string (single-origin deployment behind a proxy) means relative URLs. */
export function apiBaseUrl(configured: string | undefined): string {
  return configured ?? "http://localhost:3000";
}

/** Empty VITE_LIVE_URL (single-origin proxy) means the same origin under /live, as an absolute ws(s) URL because WebSocket rejects relative ones. */
export function liveUrl(configured: string | undefined, location: { protocol: string; host: string }): string {
  if (configured === undefined) return "ws://localhost:3002";
  if (configured !== "") return configured;
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/live`;
}
export const api: string = apiBaseUrl(import.meta.env.VITE_API_URL);

export async function action<T>(name: string, body: unknown): Promise<T | null> {
  const response = await fetch(`${api}/actions/${name}`, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return response.ok ? await response.json() as T : null;
}

/** Like `action`, but keeps the server's error message, for forms that show it (the query input). */
export async function actionResult<T>(name: string, body: unknown): Promise<{ data: T } | { error: string }> {
  const response = await fetch(`${api}/actions/${name}`, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (response.ok) return { data: await response.json() as T };
  const failure = await response.json().catch(() => null) as { error?: unknown } | null;
  return { error: typeof failure?.error === "string" ? failure.error : String(response.status) };
}
