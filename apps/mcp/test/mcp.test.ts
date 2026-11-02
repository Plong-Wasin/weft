import { afterAll, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createDatabase } from "@weft/db";
import { withRollback } from "../../../packages/db/src/test-helpers";
import { createApp } from "../../api/src/app";
import { createMcpHttpHandler, createMcpServer } from "../src/server";

const { client: pg, db } = createDatabase();
afterAll(async () => pg.end());

async function setup(transaction: Parameters<Parameters<typeof withRollback>[1]>[0], token?: string) {
  const app = createApp(undefined, transaction);
  const call = (path: string, body: unknown, cookie?: string) => app.handle(new Request(`http://localhost${path}`, {
    method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body),
  }));
  const signUp = await call("/api/auth/sign-up/email", { name: "Dev", email: `${crypto.randomUUID()}@example.test`, password: "a-secure-password" });
  const cookie = signUp.headers.get("set-cookie")!.split(";")[0]!;
  const slug = `mcp-${crypto.randomUUID().slice(0, 8)}`;
  await call("/actions/create_workspace", { name: "Team", slug }, cookie);
  const issued = await (await call("/actions/create_api_token", { name: "mcp" }, cookie)).json() as { token: string };
  const server = createMcpServer({ apiUrl: "http://localhost", token: token ?? issued.token, fetch: (input, init) => app.handle(new Request(input as string, init)) });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(b);
  return { client, call, cookie, slug };
}

const text = (result: unknown) => ((result as { content: Array<{ text: string }> }).content)[0]!.text;

test.concurrent("tools come from the registry, minus delete_project, delete_workspace and token management, with schemas", async () => {
  await withRollback(db, async (transaction) => {
    const { client } = await setup(transaction);
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    expect(names).toContain("create_work_item");
    expect(names).toContain("list_projects");
    for (const hidden of ["delete_project", "delete_workspace", "create_api_token", "list_api_tokens", "revoke_api_token", "list_authorized_apps", "revoke_authorized_app", "create_workspace"]) expect(names).not.toContain(hidden);
    const create = tools.find((tool) => tool.name === "create_project")!;
    expect(create.inputSchema.properties).toHaveProperty("name");
    expect(create.inputSchema.properties).toHaveProperty("workspace");
    expect(create.inputSchema.properties).not.toHaveProperty("workspaceId");
  });
});

test.concurrent("a write via MCP runs immediately under the owner's permissions and Activity records source mcp", async () => {
  await withRollback(db, async (transaction) => {
    const { client, call, cookie, slug } = await setup(transaction);
    const project = JSON.parse(text(await client.callTool({ name: "create_project", arguments: { workspace: slug, name: "Mobile", key: "MOB", visibility: "public" } }))) as { id: string };
    const item = JSON.parse(text(await client.callTool({ name: "create_work_item", arguments: { projectId: project.id, title: "Ship it" } }))) as { id: string };
    const listed = JSON.parse(text(await client.callTool({ name: "list_projects", arguments: { workspace: slug } }))) as Array<{ key: string }>;
    expect(listed.map((row) => row.key)).toContain("MOB");
    const log = await (await call("/actions/list_work_item_activities", { workItemId: item.id }, cookie)).json() as Array<{ source: string }>;
    expect(log.length).toBeGreaterThan(0);
    expect(log.every((row) => row.source === "mcp")).toBe(true);
  });
});

test.concurrent("permission failures, unknown workspaces and revoked tokens come back as tool errors", async () => {
  await withRollback(db, async (transaction) => {
    const { client, slug } = await setup(transaction);
    const missing = await client.callTool({ name: "list_projects", arguments: { workspace: "nope" } });
    expect(missing.isError).toBe(true);
    const noSlug = await client.callTool({ name: "list_projects", arguments: {} });
    expect(noSlug.isError).toBe(true);
    const bogus = await setup(transaction, "weft_bogus");
    const denied = await bogus.client.callTool({ name: "list_projects", arguments: { workspace: slug } });
    expect(denied.isError).toBe(true);
    expect(text(denied)).toContain("Unauthenticated");
  });
});

test.concurrent("MCP lists every phase 2 Action with its PQL guidance", async () => {
  await withRollback(db, async (transaction) => {
    const { client } = await setup(transaction);
    const tools = (await client.listTools()).tools;
    const names = tools.map((tool) => tool.name);
    for (const name of ["create_cycle", "transfer_cycle_items", "create_module", "add_module_items", "submit_intake_item", "accept_intake_item", "duplicate_intake_item", "create_work_item_relation", "create_comment", "list_comment_versions", "list_timeline", "set_project_features"]) expect(names).toContain(name);
    expect(tools.find((tool) => tool.name === "create_cycle")!.annotations?.readOnlyHint).toBe(false);
    expect(tools.find((tool) => tool.name === "list_cycles")!.annotations?.readOnlyHint).toBe(true);
    const search = tools.find((tool) => tool.name === "search_work_items")!;
    expect(search.description).toContain("free text");
    expect(search.description).toContain("cycle = activeCycle()");
    expect(tools.find((tool) => tool.name === "list_work_items")!.description).toContain("PQL");
  });
});

test.concurrent("HTTP MCP lists and calls tools with an API token, independently per request", async () => {
  await withRollback(db, async (transaction) => {
    const { call, cookie, slug } = await setup(transaction);
    const tokenResult = await call("/actions/create_api_token", { name: "http-mcp" }, cookie);
    const { token } = await tokenResult.json() as { token: string };
    const handler = createMcpHttpHandler({ apiUrl: "http://localhost", publicUrl: "https://weft.example", fetch: (input, init) => createApp(undefined, transaction).handle(new Request(input as string, init)) });
    const rpc = (id: number, method: string, params: unknown) => handler(new Request("https://weft.example/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    }));
    const initialized = await rpc(1, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "0" } });
    expect(initialized.status).toBe(200);
    const listed = await rpc(2, "tools/list", {});
    expect(listed.status).toBe(200);
    expect(listed.headers.get("mcp-session-id")).toBeNull();
    const listedBody = await listed.json() as { result: { tools: Array<{ name: string }> } };
    expect(listedBody.result.tools.map((tool) => tool.name)).toContain("list_projects");
    const project = await rpc(3, "tools/call", { name: "create_project", arguments: { workspace: slug, name: "HTTP", key: "HTTP", visibility: "public" } });
    expect(project.status).toBe(200);
    const projectResult = await project.json() as { result: { content: Array<{ text: string }> } };
    expect(JSON.parse(projectResult.result.content[0]!.text)).toMatchObject({ key: "HTTP" });
  });
});

test.concurrent("HTTP MCP challenges missing credentials and relays API authentication failures", async () => {
  await withRollback(db, async (transaction) => {
    const handler = createMcpHttpHandler({ apiUrl: "http://localhost", publicUrl: "https://weft.example", fetch: (input, init) => createApp(undefined, transaction).handle(new Request(input as string, init)) });
    const missing = await handler(new Request("https://weft.example/mcp", { method: "POST", body: "{}" }));
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toContain("Bearer");
    expect(missing.headers.get("www-authenticate")).toContain("https://weft.example/.well-known/oauth-protected-resource");
    const invalid = await handler(new Request("https://weft.example/mcp", { method: "POST", headers: { authorization: "Bearer weft_invalid", "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "0" } } }) }));
    expect(invalid.status).toBe(401);
    expect(invalid.headers.get("www-authenticate")).toContain("Bearer");
  });
});
