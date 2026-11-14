import { afterAll, expect, test } from "bun:test";
import { createDatabase, type Database } from "@weft/db";
import { createAgentActions, createApiTokenActions, mintApiToken, createProjectActions, createRuntimeActions, createWorkItemActions } from "@weft/actions";
import { withRollback } from "../../../packages/db/src/test-helpers";
import { createApp } from "../../api/src/app";
import { main } from "../src/program";

const { client, db } = createDatabase();
afterAll(async () => client.end());

async function run(app: ReturnType<typeof createApp>, args: string[], token?: string) {
  const out: string[] = [];
  const err: string[] = [];
  const failed = (await main(["node", "weft", ...args], {
    fetch: (input, init) => app.handle(new Request(input as string, init)),
    env: { WEFT_API_URL: "http://localhost", ...(token ? { WEFT_TOKEN: token } : {}) },
    stdout: (text) => out.push(text), stderr: (text) => err.push(text),
  })) !== 0;
  return { out: out.join(""), err: err.join(""), failed };
}

async function signedUp(app: ReturnType<typeof createApp>, name: string) {
  const response = await app.handle(new Request("http://localhost/api/auth/sign-up/email", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, email: `${crypto.randomUUID()}@example.test`, password: "a-secure-password" }),
  }));
  const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
  const me = await (await app.handle(new Request("http://localhost/api/me", { headers: { cookie } }))).json() as { user: { id: string } };
  return { cookie, id: me.user.id };
}

async function callAction(app: ReturnType<typeof createApp>, path: string, body: unknown, cookie?: string) {
  return app.handle(new Request(`http://localhost${path}`, {
    method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body),
  }));
}

test.concurrent("the CLI refuses a Member an Agent without Agent access, and the item gets no Run", async () => {
  await withRollback(db, async (transaction: Database) => {
    const app = createApp(undefined, transaction);
    const owner = await signedUp(app, "Owner");
    const pm = await signedUp(app, "PM");
    const slug = `cli-neg-${crypto.randomUUID().slice(0, 8)}`;
    const workspace = await (await callAction(app, "/actions/create_workspace", { name: "Team", slug }, owner.cookie)).json() as { id: string };
    const { workspaceMembers, projectMembers } = await import("@weft/db");
    await transaction.insert(workspaceMembers).values({ workspaceId: workspace.id, userId: pm.id, role: "Member" });
    const project = await createProjectActions(transaction).createProject.handler({ userId: owner.id }, { workspaceId: workspace.id, name: "Neg", key: `CN${crypto.randomUUID().slice(0, 4).toUpperCase()}`, visibility: "public" });
    await transaction.insert(projectMembers).values({ workspaceId: workspace.id, projectId: project.id, userId: pm.id, role: "Member" });
    const agents = createAgentActions(transaction);
    const agent = await agents.createAgent.handler({ userId: owner.id }, { workspaceId: workspace.id, name: "Reply Agent", instructions: "Work", model: "default" });
    await agents.setAgentProjectAccess.handler({ userId: owner.id }, { agentId: agent.id, allProjects: true, projectIds: [] });
    await agents.setAgentAccess.handler({ userId: owner.id }, { agentId: agent.id, userIds: [] });
    const pmToken = (await (await callAction(app, "/actions/create_api_token", { name: "pm-cli" }, pm.cookie)).json() as { token: string }).token;

    const refused = await run(app, ["create-work-item", "--workspace", slug, "--project-id", project.id, "--title", "PM assigns the Agent", "--assignee-ids", JSON.stringify([agent.userId])], pmToken);
    expect(refused.failed).toBe(true);
    expect(refused.err).toContain("Agent access");
    expect(refused.err).toContain("Ask its owner or an Admin to grant access");
    const { runs } = await import("@weft/db");
    expect((await transaction.select({ id: runs.id }).from(runs)).length).toBe(0);
  });
});

test.concurrent("the CLI shows the Run token refusal when an Agent Run tries to delete, and nothing is deleted", async () => {
  await withRollback(db, async (transaction: Database) => {
    const app = createApp(undefined, transaction);
    const owner = await signedUp(app, "Owner");
    const slug = `cli-del-${crypto.randomUUID().slice(0, 8)}`;
    const workspace = await (await callAction(app, "/actions/create_workspace", { name: "Team", slug }, owner.cookie)).json() as { id: string };
    await callAction(app, "/actions/set_autopilot_setting", { workspaceId: workspace.id, allowAutopilot: true }, owner.cookie);
    const personal = await mintApiToken(transaction, { userId: owner.id, name: "CLI @ cli-test", description: "Signed in with weft login", expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) });
    const project = await createProjectActions(transaction).createProject.handler({ userId: owner.id }, { workspaceId: workspace.id, name: "Del", key: `CD${crypto.randomUUID().slice(0, 4).toUpperCase()}`, visibility: "private" });
    const agents = createAgentActions(transaction);
    const agent = await agents.createAgent.handler({ userId: owner.id }, { workspaceId: workspace.id, name: "Runtime Agent", instructions: "Work", model: "default" });
    await agents.setAgentProjectAccess.handler({ userId: owner.id }, { agentId: agent.id, allProjects: true, projectIds: [] });
    const registration = await (await app.handle(new Request("http://localhost/api/daemon/register", {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${personal.token}` },
      body: JSON.stringify({ hostname: "cli-test", version: "1", agentClis: ["claude"] }),
    }))).json() as { runtimes: Array<{ id: string }>; daemonToken: string };
    const daemon = { token: registration.daemonToken };
    const runtimeId = registration.runtimes[0]!.id;
    await createRuntimeActions(transaction).shareRuntime.handler({ userId: owner.id }, { runtimeId });
    await agents.updateAgent.handler({ userId: owner.id }, { agentId: agent.id, runtimeId });
    const item = await createWorkItemActions(transaction).createWorkItem.handler({ userId: owner.id }, { projectId: project.id, title: "Keep me", assigneeIds: [agent.userId] });
    const claimed = await (await app.handle(new Request("http://localhost/api/daemon/runs/claim", { method: "POST", headers: { authorization: `Bearer ${daemon.token}` } }))).json() as Array<{ token: string }>;
    const runToken = claimed[0]!.token;
    expect(runToken).toStartWith("weft_run_");

    const refused = await run(app, ["delete-work-item", "--work-item-id", item.id], runToken);
    expect(refused.failed).toBe(true);
    expect(refused.err).toContain("Agents cannot delete anything");
    const kept = await run(app, ["get-work-item", "--workspace", slug, "--display-id", item.displayId], runToken);
    expect(kept.failed).toBe(false);
    expect(JSON.parse(kept.out).title).toBe("Keep me");
  });
});
