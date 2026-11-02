import { api } from "./api";

export type AiStatus = { provider: string; model: string; key: "present" | "missing"; configured: boolean };
type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export const aiStatusKey = (workspaceId: string) => ["ai-status", workspaceId] as const;

/** Calls POST /api/ai/status. Null means the status is unknown (offline, no access): callers must not treat that as "not configured". */
export async function requestAiStatus(workspaceId: string, fetcher: Fetcher = (input, init) => fetch(input, init)): Promise<AiStatus | null> {
  try {
    const response = await fetcher(`${api}/api/ai/status`, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId }) });
    if (!response.ok) return null;
    const data = await response.json().catch(() => null) as Partial<AiStatus> | null;
    return typeof data?.provider === "string" && typeof data.model === "string" && (data.key === "present" || data.key === "missing") && typeof data.configured === "boolean" ? data as AiStatus : null;
  } catch {
    return null;
  }
}
