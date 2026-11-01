export const api = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

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
