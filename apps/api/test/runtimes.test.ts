import { afterAll, expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDatabase, type Database } from "@weft/db";
import { createAgentActions, createProjectActions, createRuntimeActions, createWorkItemActions } from "@weft/actions";
import { withRollback } from "../../../packages/db/src/test-helpers";
import { startDaemon } from "../../cli/src/daemon";
import { createApp } from "../src/app";

const { client, db } = createDatabase();
afterAll(async () => client.end());

async function setup(transaction: Database) {
  const app = createApp(undefined, transaction);
  const post = (path: string, body: unknown, cookie?: string, token?: string) => app.handle(new Request(`http://localhost${path}`, {
    method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
  }));
  const signUp = async () => {
    const response = await post("/api/auth/sign-up/email", { name: "Dev", email: `${crypto.randomUUID()}@example.test`, password: "a-secure-password" });
    const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
    const me = await (await app.handle(new Request("http://localhost/api/me", { headers: { cookie } }))).json() as { user: { id: string } };
    return { cookie, id: me.user.id };
  };
  return { app, post, signUp };
}

test.concurrent("the API registers Daemon CLIs and keeps private Runtime rows out of other members' responses", async () => {
  await withRollback(db, async (transaction) => {
    const { app, post, signUp } = await setup(transaction);
    const owner = await signUp();
    const workspace = await (await post("/actions/create_workspace", { name: "Team", slug: `rt-${crypto.randomUUID()}` }, owner.cookie)).json() as { id: string };
    const token = await (await post("/actions/create_api_token", { name: "daemon" }, owner.cookie)).json() as { id: string; token: string };
    const registration = await post("/actions/register_daemon", { hostname: "devbox", version: "1", agentClis: ["claude", "codex"] }, undefined, token.token);
    expect(registration.status).toBe(200);
    expect((await registration.json() as { runtimes: unknown[] }).runtimes).toHaveLength(2);
    const visible = await app.handle(new Request(`http://localhost/actions/list_runtimes`, { method: "POST", headers: { cookie: owner.cookie, "content-type": "application/json" }, body: JSON.stringify({ workspaceId: workspace.id }) }));
    expect((await visible.json() as unknown[])).toHaveLength(2);
  });
});

test.concurrent("browser CLI sign-in creates a host-named Personal API token and returns it only to the local callback", async () => {
  await withRollback(db, async (transaction) => {
    const { app, signUp } = await setup(transaction);
    const owner = await signUp();
    const query = new URLSearchParams({ callback: "http://127.0.0.1:43210/callback", state: "state-123", hostname: "devbox" });
    const response = await app.handle(new Request(`http://localhost/api/cli/login?${query}`, { headers: { cookie: owner.cookie } }));
    expect(response.status).toBe(302);
    const destination = new URL(response.headers.get("location")!);
    expect(destination.origin).toBe("http://127.0.0.1:43210");
    expect(destination.searchParams.get("state")).toBe("state-123");
    expect(destination.searchParams.get("token")).toStartWith("weft_");
    const tokens = await (await app.handle(new Request("http://localhost/actions/list_api_tokens", { method: "POST", headers: { cookie: owner.cookie, "content-type": "application/json" }, body: "{}" }))).json() as Array<{ name: string }>;
    expect(tokens.map((token) => token.name)).toContain("Daemon @ devbox");
  });
});

test.concurrent("the Daemon WebSocket accepts heartbeats and closes when its Personal API token is revoked", async () => {
  await withRollback(db, async (transaction) => {
    const { app, post, signUp } = await setup(transaction);
    const owner = await signUp();
    const workspace = await (await post("/actions/create_workspace", { name: "Team", slug: `ws-${crypto.randomUUID()}` }, owner.cookie)).json() as { id: string };
    const token = await (await post("/actions/create_api_token", { name: "daemon" }, owner.cookie)).json() as { id: string; token: string };
    await post("/actions/register_daemon", { hostname: "devbox", version: "1", agentClis: ["claude"] }, undefined, token.token);
    app.listen(0);
    try {
      const ws = new WebSocket(`ws://localhost:${app.server!.port}/api/daemon?token=${encodeURIComponent(token.token)}`);
      await new Promise<void>((resolve, reject) => { ws.addEventListener("open", () => resolve(), { once: true }); ws.addEventListener("error", () => reject(new Error("WebSocket failed")), { once: true }); });
      const ack = new Promise<string>((resolve) => ws.addEventListener("message", (event) => resolve(String(event.data)), { once: true }));
      ws.send(JSON.stringify({ type: "heartbeat" }));
      expect(JSON.parse(await ack)).toMatchObject({ type: "heartbeat_ack" });
      await post("/actions/revoke_api_token", { tokenId: token.id }, owner.cookie);
      const closed = new Promise<number>((resolve) => ws.addEventListener("close", (event) => resolve(event.code), { once: true }));
      ws.send(JSON.stringify({ type: "heartbeat" }));
      expect(await closed).toBe(1008);
      const listed = await app.handle(new Request("http://localhost/actions/list_runtimes", { method: "POST", headers: { cookie: owner.cookie, "content-type": "application/json" }, body: JSON.stringify({ workspaceId: workspace.id }) }));
      expect(await listed.json()).toMatchObject([{ online: false }]);
    } finally {
      app.stop(true);
    }
  });
});

test.concurrent("a fake Runtime CLI uses its Run token through the real Daemon and API, then completes with Autopilot Activity", async () => {
  await withRollback(db, async (transaction) => {
    const { app, post, signUp } = await setup(transaction);
    const owner = await signUp();
    const workspace = await (await post("/actions/create_workspace", { name: "Team", slug: `e2e-${crypto.randomUUID()}` }, owner.cookie)).json() as { id: string; slug: string };
    const token = await (await post("/actions/create_api_token", { name: "daemon" }, owner.cookie)).json() as { id: string; token: string };
    const projects = createProjectActions(transaction);
    const project = await projects.createProject.handler({ userId: owner.id }, { workspaceId: workspace.id, name: "Runtime work", key: `RT${crypto.randomUUID().slice(0, 4).toUpperCase()}`, visibility: "private" });
    const work = createWorkItemActions(transaction);
    const states = await work.listStates.handler({ userId: owner.id }, { projectId: project.id });
    const done = states.find((state) => state.group === "completed")!;
    const agents = createAgentActions(transaction);
    const agent = await agents.createAgent.handler({ userId: owner.id }, { workspaceId: workspace.id, name: "Runtime Agent", instructions: "Work on the request", model: "default" });
    await agents.setAgentProjectAccess.handler({ userId: owner.id }, { agentId: agent.id, allProjects: true, projectIds: [] });

    const path = await mkdtemp(join(tmpdir(), "weft-e2e-path-"));
    const controller = new AbortController();
    let daemonTask: Promise<void> | undefined;
    app.listen(0);
    try {
      await mkdir(path, { recursive: true });
      const root = process.cwd();
      const weft = join(path, "weft");
      await writeFile(weft, `#!/bin/sh\nexec bun "${root}/apps/cli/src/index.ts" "$@"\n`);
      await chmod(weft, 0o755);
      const claude = join(path, "claude");
      await writeFile(claude, "#!/bin/sh\nweft create-comment --work-item-id \"$WEFT_ITEM_ID\" --body '{\"type\":\"doc\",\"content\":[{\"type\":\"paragraph\",\"content\":[{\"type\":\"text\",\"text\":\"Comment from fake CLI\"}]}]}'\nweft update-work-item --work-item-id \"$WEFT_ITEM_ID\" --state-id \"$WEFT_DONE_STATE_ID\"\nprintf '%s\\n' '{\"type\":\"result\",\"result\":\"Runtime work completed\"}'\n");
      await chmod(claude, 0o755);
      const apiUrl = `http://localhost:${app.server!.port}`;
      const registration = await (await post("/actions/register_daemon", { hostname: "e2e", version: "1", agentClis: ["claude"] }, undefined, token.token)).json() as { runtimes: Array<{ id: string }> };
      const runtimeId = registration.runtimes[0]!.id;
      await createRuntimeActions(transaction).shareRuntime.handler({ userId: owner.id }, { runtimeId });
      await agents.updateAgent.handler({ userId: owner.id }, { agentId: agent.id, runtimeId });
      const item = await work.createWorkItem.handler({ userId: owner.id }, { projectId: project.id, title: "Finish this item", assigneeIds: [agent.userId] });
      // The shell CLI is the real `weft` command and uses the Run token placed in its environment by the Daemon.
      daemonTask = startDaemon({ env: { WEFT_TOKEN: token.token, WEFT_API_URL: apiUrl, PATH: `${path}:${Bun.env.PATH ?? ""}`, WEFT_HOSTNAME: "e2e", WEFT_WORKSPACE: workspace.slug, WEFT_ITEM_ID: item.id, WEFT_DONE_STATE_ID: done.id }, signal: controller.signal, heartbeatMs: 20, reprobeMs: 60_000 });

      let runStatus = "queued";
      for (let i = 0; i < 200 && !["completed", "failed"].includes(runStatus); i++) {
        const response = await post("/actions/list_runs", { workItemId: item.id }, owner.cookie);
        const rows = await response.json() as Array<{ status: string }>;
        runStatus = rows[0]?.status ?? "queued";
        if (!["completed", "failed"].includes(runStatus)) await Bun.sleep(25);
      }
      expect(runStatus).toBe("completed");
      const updated = await (await post("/actions/get_work_item", { workspaceId: workspace.id, displayId: item.displayId }, owner.cookie)).json() as { stateId: string };
      expect(updated.stateId).toBe(done.id);
      const comments = await (await post("/actions/list_comments", { workItemId: item.id }, owner.cookie)).json() as Array<{ bodyText: string }>;
      expect(comments.map((comment) => comment.bodyText)).toContain("Comment from fake CLI");
      const activity = await (await post("/actions/list_work_item_activities", { workItemId: item.id }, owner.cookie)).json() as Array<{ source: string }>;
      expect(activity.map((entry) => entry.source)).toContain("agent_autopilot");
    } finally {
      controller.abort();
      await daemonTask?.catch(() => {});
      app.stop(true);
      await rm(path, { recursive: true, force: true });
    }
  });
});

test.concurrent("cancelling a running Runtime Run signals the Daemon, kills its CLI and acknowledges cancellation", async () => {
  await withRollback(db, async (transaction) => {
    const { app, post, signUp } = await setup(transaction);
    const owner = await signUp();
    const workspace = await (await post("/actions/create_workspace", { name: "Team", slug: `cancel-${crypto.randomUUID()}` }, owner.cookie)).json() as { id: string };
    const token = await (await post("/actions/create_api_token", { name: "daemon" }, owner.cookie)).json() as { token: string };
    const project = await createProjectActions(transaction).createProject.handler({ userId: owner.id }, { workspaceId: workspace.id, name: "Cancel", key: `CN${crypto.randomUUID().slice(0, 4).toUpperCase()}`, visibility: "private" });
    const agents = createAgentActions(transaction);
    const agent = await agents.createAgent.handler({ userId: owner.id }, { workspaceId: workspace.id, name: "Runtime Agent", instructions: "Wait", model: "default" });
    await agents.setAgentProjectAccess.handler({ userId: owner.id }, { agentId: agent.id, allProjects: true, projectIds: [] });
    const path = await mkdtemp(join(tmpdir(), "weft-cancel-path-"));
    const marker = join(path, "started");
    const controller = new AbortController();
    let daemonTask: Promise<void> | undefined;
    app.listen(0);
    try {
      await writeFile(join(path, "claude"), `#!/bin/sh\necho started > "${marker}"\nexec bun -e 'await new Promise(() => {})'\n`);
      await chmod(join(path, "claude"), 0o755);
      const registration = await (await post("/actions/register_daemon", { hostname: "cancel-test", version: "1", agentClis: ["claude"] }, undefined, token.token)).json() as { runtimes: Array<{ id: string }> };
      const runtimeId = registration.runtimes[0]!.id;
      await createRuntimeActions(transaction).shareRuntime.handler({ userId: owner.id }, { runtimeId });
      await agents.updateAgent.handler({ userId: owner.id }, { agentId: agent.id, runtimeId });
      const item = await createWorkItemActions(transaction).createWorkItem.handler({ userId: owner.id }, { projectId: project.id, title: "Stop this run", assigneeIds: [agent.userId] });
      daemonTask = startDaemon({ env: { WEFT_TOKEN: token.token, WEFT_API_URL: `http://localhost:${app.server!.port}`, PATH: `${path}:${Bun.env.PATH ?? ""}`, WEFT_MARKER: marker }, signal: controller.signal, heartbeatMs: 20, reprobeMs: 60_000 });
      let status = "queued";
      for (let i = 0; i < 300 && status !== "running"; i++) {
        const rows = await (await post("/actions/list_runs", { workItemId: item.id }, owner.cookie)).json() as Array<{ status: string }>;
        status = rows[0]?.status ?? "queued";
        if (status !== "running") await Bun.sleep(20);
      }
      expect(status).toBe("running");
      for (let i = 0; i < 100 && !(await Bun.file(marker).exists()); i++) await Bun.sleep(10);
      expect(await Bun.file(marker).exists()).toBe(true);
      await post("/actions/cancel_run", { runId: (await (await post("/actions/list_runs", { workItemId: item.id }, owner.cookie)).json() as Array<{ id: string }>)[0]!.id }, owner.cookie);
      status = "stopping";
      for (let i = 0; i < 300 && status !== "cancelled"; i++) {
        const rows = await (await post("/actions/list_runs", { workItemId: item.id }, owner.cookie)).json() as Array<{ status: string }>;
        status = rows[0]?.status ?? "missing";
        if (status !== "cancelled") await Bun.sleep(20);
      }
      expect(status).toBe("cancelled");
    } finally {
      controller.abort();
      await daemonTask?.catch(() => {});
      app.stop(true);
      await rm(path, { recursive: true, force: true });
    }
  });
});
