/** Base URL of the API. An empty string (single-origin deployment behind a proxy) means relative URLs. */
export function apiBaseUrl(configured: string | undefined, origin?: string): string {
  const value = configured ?? "http://localhost:3000";
  if (!value || /^[a-z][a-z\d+.-]*:\/\//i.test(value)) return value;
  const baseOrigin = origin ?? (typeof window === "undefined" ? undefined : window.location.origin);
  return baseOrigin ? new URL(value, baseOrigin).toString().replace(/\/$/, "") : value;
}

/** Builds a public webhook address from the API origin used by action requests. */
export function webhookUrl(apiBase: string, path: string, origin?: string): string {
  const base = apiBase.replace(/\/+$/, "");
  return `${(base || origin || window.location.origin).replace(/\/+$/, "")}${path}`;
}

/** Empty VITE_LIVE_URL (single-origin proxy) means the same origin under /live, as an absolute ws(s) URL because WebSocket rejects relative ones. */
export function liveUrl(configured: string | undefined, location: { protocol: string; host: string }): string {
  if (configured === undefined) return "ws://localhost:3002";
  if (configured !== "") return configured;
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/live`;
}
export const api: string = apiBaseUrl(import.meta.env.VITE_API_URL);

/** An Action that returns null is sent as a 200 with an empty body, which `response.json()` rejects. */
async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  return text === "" ? null : JSON.parse(text);
}

export async function action<T>(name: string, body: unknown): Promise<T | null> {
  try {
    const response = await fetch(`${api}/actions/${name}`, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return response.ok ? await readBody(response) as T | null : null;
  } catch { return null; }
}

/** Like `action`, but keeps the server's error message, for forms that show it (the query input). */
export async function actionResult<T>(name: string, body: unknown): Promise<{ data: T } | { error: string }> {
  try {
    const response = await fetch(`${api}/actions/${name}`, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (response.ok) return { data: await readBody(response) as T };
    const failure = await response.json().catch(() => null) as { error?: unknown } | null;
    return { error: typeof failure?.error === "string" ? failure.error : String(response.status) };
  } catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
}
