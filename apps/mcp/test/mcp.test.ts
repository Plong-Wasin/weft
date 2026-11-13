import { afterAll, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createDatabase, oauthAccessToken, oauthClient } from "@weft/db";
import { eq } from "drizzle-orm";
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
  const { user } = await signUp.clone().json() as { user: { id: string } };
  const slug = `mcp-${crypto.randomUUID().slice(0, 8)}`;
  await call("/actions/create_workspace", { name: "Team", slug }, cookie);
  const issued = await (await call("/actions/create_api_token", { name: "mcp" }, cookie)).json() as { token: string };
  const server = createMcpServer({ apiUrl: "http://localhost", token: token ?? issued.token, fetch: (input, init) => app.handle(new Request(input as string, init)) });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(b);
  return { client, call, cookie, slug, userId: user.id };
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

test.concurrent("MCP exposes Markdown first and creates a table comment from a Markdown field", async () => {
  await withRollback(db, async (transaction) => {
    const { client, slug } = await setup(transaction);
    const tools = (await client.listTools()).tools;
    const commentTool = tools.find((tool) => tool.name === "create_comment")!;
    const properties = commentTool.inputSchema.properties as Record<string, { description?: string }>;
    expect(Object.keys(properties).at(0)).toBe("bodyMarkdown");
    expect(properties.bodyMarkdown?.description).toContain("Markdown");
    const project = JSON.parse(text(await client.callTool({ name: "create_project", arguments: { workspace: slug, name: "Comments", key: "CMT", visibility: "public" } }))) as { id: string };
    const item = JSON.parse(text(await client.callTool({ name: "create_work_item", arguments: { projectId: project.id, title: "Markdown" } }))) as { id: string };
    const created = JSON.parse(text(await client.callTool({ name: "create_comment", arguments: { workItemId: item.id, bodyMarkdown: "| A | B |\n| --- | --- |\n| one | two |" } }))) as { markdown: string; body: { content: Array<{ type: string }> } };
    expect(created.body.content[0]?.type).toBe("table");
    expect(created.markdown).toContain("| one | two |");
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
    for (const name of ["create_cycle", "transfer_cycle_items", "create_module", "add_module_items", "submit_intake_item", "accept_intake_item", "duplicate_intake_item", "create_work_item_relation", "create_comment", "list_comment_versions", "list_timeline", "set_project_features", "get_estimate", "create_estimate", "update_estimate", "delete_estimate_point", "get_estimate_usage", "switch_estimate_type", "delete_estimate", "archive_work_item", "restore_work_item"]) expect(names).toContain(name);
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

test.concurrent("protected-resource metadata identifies /mcp and the Weft authorization server", async () => {
  const handler = createMcpHttpHandler({ apiUrl: "http://localhost", publicUrl: "https://weft.example/", fetch: fetch });
  const response = await handler(new Request("https://weft.example/.well-known/oauth-protected-resource"));
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("application/json");
  expect(await response.json()).toEqual({
    resource: "https://weft.example/mcp",
    authorization_servers: ["https://weft.example/api/auth"],
    scopes_supported: ["offline_access"],
  });
});

test.concurrent("the path-inserted metadata URL (RFC 9728) answers like the root one, and a rejected token is flagged invalid_token", async () => {
  const handler = createMcpHttpHandler({
    apiUrl: "http://api.test", publicUrl: "https://weft.example/",
    fetch: (async () => new Response(JSON.stringify({ error: "Unauthenticated" }), { status: 401 })) as unknown as typeof fetch,
  });
  const response = await handler(new Request("https://weft.example/.well-known/oauth-protected-resource/mcp"));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ resource: "https://weft.example/mcp", authorization_servers: ["https://weft.example/api/auth"], scopes_supported: ["offline_access"] });
  const rejected = await handler(new Request("https://weft.example/mcp", { method: "POST", headers: { authorization: "Bearer nope" } }));
  expect(rejected.status).toBe(401);
  expect(rejected.headers.get("www-authenticate")).toContain('error="invalid_token"');
  const missing = await handler(new Request("https://weft.example/mcp", { method: "POST" }));
  expect(missing.headers.get("www-authenticate")).not.toContain("invalid_token");
});

test.concurrent("expired and revoked OAuth access tokens receive the discovery challenge", async () => {
  await withRollback(db, async (transaction) => {
    const { userId, slug } = await setup(transaction);
    const clientId = `mcp-${crypto.randomUUID()}`;
    await transaction.insert(oauthClient).values({ id: crypto.randomUUID(), clientId, redirectUris: [] });
    const accessToken = `oauth-${crypto.randomUUID()}`;
    const tokenHash = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(accessToken))).toString("base64url");
    const accessId = crypto.randomUUID();
    await transaction.insert(oauthAccessToken).values({
      id: accessId, token: tokenHash, clientId, userId, scopes: [], createdAt: new Date(), expiresAt: new Date(Date.now() - 1_000),
    });
    const handler = createMcpHttpHandler({ apiUrl: "http://localhost", publicUrl: "https://weft.example", fetch: (input, init) => createApp(undefined, transaction).handle(new Request(input as string, init)) });
    const request = () => handler(new Request("https://weft.example/mcp", {
      method: "POST", headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" }, body: "{}",
    }));
    const expired = await request();
    expect(expired.status).toBe(401);
    expect(expired.headers.get("www-authenticate")).toContain("https://weft.example/.well-known/oauth-protected-resource");
    await transaction.update(oauthAccessToken).set({ expiresAt: new Date(Date.now() + 60_000), revoked: new Date() }).where(eq(oauthAccessToken.id, accessId));
    const revoked = await request();
    expect(revoked.status).toBe(401);
    expect(revoked.headers.get("www-authenticate")).toContain("https://weft.example/.well-known/oauth-protected-resource");
    await transaction.update(oauthAccessToken).set({ expiresAt: new Date(Date.now() + 60_000), revoked: null }).where(eq(oauthAccessToken.id, accessId));
    const call = await handler(new Request("https://weft.example/mcp", {
      method: "POST", headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "create_project", arguments: { workspace: slug, name: "OAuth HTTP", key: "OAUTH", visibility: "public" } } }),
    }));
    expect(call.status).toBe(200);
    expect((await call.json() as { result: { content: Array<{ text: string }> } }).result.content[0]!.text).toContain("OAUTH");
  });
});

test.concurrent("MCP: a Simple project refuses a Cycle tool with the feature name and where an admin turns it on, and create_project takes the shape", async () => {
  await withRollback(db, async (transaction) => {
    const { client, slug } = await setup(transaction);
    const project = JSON.parse(text(await client.callTool({ name: "create_project", arguments: { workspace: slug, name: "Simple", key: "SMP", visibility: "public", shape: "simple" } }))) as { id: string; features: Record<string, boolean> };
    expect(project.features).toEqual({ cycles: false, modules: false, intake: false, pages: true, views: true, types: false });
    const refused = await client.callTool({ name: "create_cycle", arguments: { projectId: project.id, name: "Sprint", startDate: "2026-01-01", endDate: "2026-01-14" } });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain("The Cycles feature is turned off");
    expect(text(refused)).toContain("Project settings > Features");
  });
});
