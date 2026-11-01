import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createActionList } from "@weft/actions";
import type { Database } from "@weft/db";

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface McpConfig {
  apiUrl: string;
  token: string;
  fetch?: FetchLike;
}

/** Actions never offered to external clients: destructive tenant removal and token management. */
const HIDDEN = new Set(["delete_project", "delete_workspace", "create_workspace", "create_api_token", "list_api_tokens", "revoke_api_token"]);

interface Schema { type?: string; properties?: Record<string, Schema>; required?: string[]; description?: string }

/**
 * MCP server derived from the Action registry: one tool per Action. Handlers never run here (the
 * Action list gets a database stub); every call goes to the API with the personal API token and
 * `x-weft-source: mcp`, so permission checks and Activity come from the same Actions as every surface.
 * No Confirmation card: the external client owns that decision.
 */
export function createMcpServer(config: McpConfig) {
  const doFetch: FetchLike = config.fetch ?? fetch;
  const base = config.apiUrl.replace(/\/$/, "");
  const actions = createActionList({} as Database).filter((action) => !HIDDEN.has(action.name));
  const byName = new Map(actions.map((action) => [action.name, action]));

  async function request(path: string, body?: unknown) {
    const response = await doFetch(`${base}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${config.token}`, "x-weft-source": "mcp", ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await response.text();
    const data = raw ? JSON.parse(raw) : null;
    if (!response.ok) throw new Error(`${response.status}: ${(data as { error?: string } | null)?.error ?? response.statusText}`);
    return data;
  }

  const server = new Server({ name: "weft", version: "0.1.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: actions.map((action) => {
      const schema = JSON.parse(JSON.stringify(action.input)) as Schema;
      const properties = { ...(schema.properties ?? {}) };
      const required = [...(schema.required ?? [])];
      if ("workspaceId" in properties) {
        delete properties.workspaceId;
        properties.workspace = { type: "string", description: "Workspace slug" };
        required.splice(0, required.length, ...required.filter((name) => name !== "workspaceId"), "workspace");
      }
      return {
        name: action.name,
        description: `${action.kind === "read" ? "Read" : "Write"} action ${action.name}`,
        inputSchema: { ...schema, type: "object" as const, properties, required },
        annotations: { readOnlyHint: action.kind === "read" },
      };
    }),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (call) => {
    const action = byName.get(call.params.name);
    if (!action) return { isError: true, content: [{ type: "text" as const, text: `Unknown tool ${call.params.name}` }] };
    try {
      const input = { ...(call.params.arguments ?? {}) } as Record<string, unknown>;
      const properties = (action.input as unknown as Schema).properties ?? {};
      if ("workspaceId" in properties) {
        const slug = input.workspace;
        delete input.workspace;
        if (typeof slug !== "string" || !slug) throw new Error("This tool needs a workspace slug in `workspace`");
        const me = await request("/api/me") as { workspaces: Array<{ id: string; slug: string }> };
        const workspace = me.workspaces.find((candidate) => candidate.slug === slug);
        if (!workspace) throw new Error(`Workspace "${slug}" not found for this token's owner`);
        input.workspaceId = workspace.id;
      }
      const result = await request(`/actions/${action.name}`, input);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }] };
    }
  });

  return server;
}
