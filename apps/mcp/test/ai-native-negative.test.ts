import { afterAll, expect, test } from "bun:test";
import { createDatabase, type Database } from "@weft/db";
import { createAgentActions, createApiTokenActions, mintApiToken, createProjectActions } from "@weft/actions";
import { createMcpServer } from "../src/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { withRollback } from "../../../packages/db/src/test-helpers";
import { createApp } from "../../api/src/app";

const { client, db } = createDatabase();
afterAll(async () => client.end());

async function setup(transaction: Database) {
  const app = createApp(undefined, transaction);
  const post = (path: string, body: unknown, options: { cookie?: string; token?: string } = {}) => app.handle(new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(options.cookie ? { cookie: options.cookie } : {}), ...(options.token ? { authorization: `Bearer ${options.token}` } : {}) },
    body: JSON.stringify(body),
  }));
  const signUp = async (name: string) => {
    const response = await post("/api/auth/sign-up/email", { name, email: `${crypto.randomUUID()}@example.test`, password: "a-secure-password" });
    const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
    const me = await (await app.handle(new Request("http://localhost/api/me", { headers: { cookie } }))).json() as { user: { id: string } };
    return { cookie, id: me.user.id };
  };
  const owner = await signUp("Owner");
  const pm = await signUp("PM");
  const slug = `neg-${crypto.randomUUID().slice(0, 8)}`;
  const workspace = await (await post("/actions/create_workspace", { name: "Team", slug }, { cookie: owner.cookie })).json() as { id: string };
  const { workspaceMembers, projectMembers } = await import("@weft/db");
  await transaction.insert(workspaceMembers).values({ workspaceId: workspace.id, userId: pm.id, role: "Member" });
  const project = await createProjectActions(transaction).createProject.handler({ userId: owner.id }, { workspaceId: workspace.id, name: "Neg", key: `NG${crypto.randomUUID().slice(0, 4).toUpperCase()}`, visibility: "public" });
  await transaction.insert(projectMembers).values({ workspaceId: workspace.id, projectId: project.id, userId: pm.id, role: "Member" });
  const agents = createAgentActions(transaction);
  const agent = await agents.createAgent.handler({ userId: owner.id }, { workspaceId: workspace.id, name: "Reply Agent", instructions: "Work", model: "default" });
  await agents.setAgentProjectAccess.handler({ userId: owner.id }, { agentId: agent.id, allProjects: true, projectIds: [] });
  // Narrow access to the owner alone: the PM is a project member but not on the Agent's access list.
  await agents.setAgentAccess.handler({ userId: owner.id }, { agentId: agent.id, userIds: [] });
  const pmToken = await (await post("/actions/create_api_token", { name: "pm-mcp" }, { cookie: pm.cookie })).json() as { token: string };
  // The real Daemon credential, as `weft login` issues it (daemonOnly, expiring).
  const daemon = await mintApiToken(transaction, { userId: owner.id, name: "Daemon @ negative-check", description: "Restricted Daemon credential", expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), daemonOnly: true });
  return { app, post, owner, pm, slug, workspace, project, agent, pmToken: pmToken.token, daemonToken: daemon.token, agents };
}

async function setupClient(transaction: Database) {
  const { app, pmToken } = await setup(transaction);
  return { client: await mcpClient(pmToken, app), app };
}

async function mcpClient(token: string, app: ReturnType<typeof createApp>) {
  const server = createMcpServer({ apiUrl: "http://localhost", token, fetch: (input, init) => app.handle(new Request(input as string, init)) });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const mcp = new Client({ name: "negative-check", version: "0" });
  await mcp.connect(b);
  return mcp;
}

const text = (result: unknown) => ((result as { content: Array<{ text: string }> }).content)[0]!.text;

test.concurrent("a Daemon credential reaches Daemon endpoints but cannot call any Action", async () => {
  await withRollback(db, async (transaction) => {
    const { post, daemonToken, pmToken, workspace } = await setup(transaction);
    const refused = await post("/actions/list_projects", { workspaceId: workspace.id }, { token: daemonToken });
    expect(refused.status).toBe(401);
    expect(await refused.json()).toEqual({ error: expect.any(String) });
    // Registration takes the Personal token and hands back the Daemon credential, which cannot register again.
    const registered = await post("/api/daemon/register", { hostname: "neg", version: "1", agentClis: ["claude"] }, { token: pmToken });
    expect(registered.status).toBe(200);
    const issued = await registered.json() as { daemonToken: string };
    expect((await post("/api/daemon/register", { hostname: "neg", version: "1", agentClis: ["claude"] }, { token: issued.daemonToken })).status).toBe(401);
    const claimed = await post("/api/daemon/runs/claim", {}, { token: issued.daemonToken });
    expect(claimed.status).toBe(200);
  });
});

test.concurrent("an Agent without Agent access is refused through MCP and the item gets no Run", async () => {
  await withRollback(db, async (transaction) => {
    const { app, pmToken, project, agent } = await setup(transaction);
    const mcp = await mcpClient(pmToken, app);
    const created = await mcp.callTool({
      name: "create_work_item",
      arguments: { projectId: project.id, title: "PM assigns an Agent", assigneeIds: [agent.userId] },
    });
    expect(created.isError).toBe(true);
    expect(text(created)).toContain("Agent access");
  });
});

test.concurrent("a PM cannot delete an Agent or the project and workspace through MCP; hidden Actions are not offered", async () => {
  await withRollback(db, async (transaction) => {
    const { app, pmToken, agent } = await setup(transaction);
    const mcp = await mcpClient(pmToken, app);
    const { tools } = await mcp.listTools();
    expect(tools.map((tool) => tool.name)).not.toContain("delete_project");
    expect(tools.map((tool) => tool.name)).not.toContain("delete_workspace");
    const deleted = await mcp.callTool({ name: "delete_agent", arguments: { agentId: agent.id } });
    expect(deleted.isError).toBe(true);
  });
});

test.concurrent("an unknown tool name says how to pick a valid one", async () => {
  await withRollback(db, async (transaction) => {
    const { app, pmToken } = await setup(transaction);
    const mcp = await mcpClient(pmToken, app);
    const unknown = await mcp.callTool({ name: "create_issue", arguments: {} });
    expect(unknown.isError).toBe(true);
    expect(text(unknown)).toContain("Unknown tool \"create_issue\"");
    expect(text(unknown)).toContain("tool list");
  });
});

test.concurrent("tool descriptions say which ids are UUIDs, how to mention someone, and that a Cycle end date is inclusive", async () => {
  await withRollback(db, async (transaction) => {
    const { client } = await setupClient(transaction);
    const tools = new Map((await client.listTools()).tools.map((tool) => [tool.name, tool]));
    expect(tools.get("create_comment")!.description).toContain("@{exact name}");
    expect(tools.get("create_comment")!.description).toContain("UUID");
    expect((tools.get("create_comment")!.inputSchema.properties as Record<string, { description?: string }>).bodyMarkdown?.description).toContain("@{exact name}");
    expect(tools.get("list_comments")!.description).toContain("UUID");
    expect(tools.get("add_cycle_items")!.description).toContain("UUIDs");
    expect(tools.get("create_cycle")!.description).toContain("both days belong to the Cycle");
  });
});
