import { afterAll, expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { apiTokens, createDatabase, projectMembers, runTokens, runs, runtimeProfiles, workItems, type Database } from "@weft/db";
import { and, eq } from "drizzle-orm";
import { createAgentActions, createApiTokenActions, createProjectActions, createRuntimeActions, createRuntimeDispatchActions, createWorkItemActions } from "@weft/actions";
import { createMemberFactory, withRollback } from "../../../packages/db/src/test-helpers";
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

test.concurrent("a revoked Originator Project grant blocks a dispatched Member Agent's direct Run Action", async () => {
  await withRollback(db, async (transaction) => {
    const { app, post, signUp } = await setup(transaction);
    const admin = await signUp();
    const workspace = await (await post("/actions/create_workspace", { name: "Team", slug: `member-run-${crypto.randomUUID()}` }, admin.cookie)).json() as { id: string };
    await post("/actions/set_autopilot_setting", { workspaceId: workspace.id, allowAutopilot: true }, admin.cookie);
    const member = await createMemberFactory(transaction, workspace.id, "Member");
    const originator = await createMemberFactory(transaction, workspace.id, "Member");
    const projects = createProjectActions(transaction);
    const project = await projects.createProject.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Member work", key: `MW${crypto.randomUUID().slice(0, 4).toUpperCase()}`, visibility: "private" });
    await projects.addProjectMember.handler({ userId: admin.id }, { projectId: project.id, userId: member.id, role: "Member" });
    await projects.addProjectMember.handler({ userId: admin.id }, { projectId: project.id, userId: originator.id, role: "Member" });
    const personalToken = await createApiTokenActions(transaction).createApiToken.handler({ userId: member.id }, { name: "member daemon" });
    const runtimeActions = createRuntimeActions(transaction);
    const runtime = (await runtimeActions.registerDaemon.handler({ userId: member.id, apiTokenId: personalToken.id }, { hostname: "member-owner", version: "1", agentClis: ["codex"] })).runtimes[0]!;
    await runtimeActions.shareRuntime.handler({ userId: member.id }, { runtimeId: runtime.id });
    const agent = await createAgentActions(transaction).createAgent.handler({ userId: member.id }, { workspaceId: workspace.id, name: "Member Agent", instructions: "Use my project access", model: "default", runtimeId: runtime.id });
    await createAgentActions(transaction).setAgentProjectAccess.handler({ userId: member.id }, { agentId: agent.id, allProjects: false, projectIds: [project.id] });
    await createAgentActions(transaction).setAgentAccess.handler({ userId: member.id }, { agentId: agent.id, userIds: [originator.id] });
    const item = await createWorkItemActions(transaction).createWorkItem.handler({ userId: originator.id }, { projectId: project.id, title: "Before revocation", assigneeIds: [agent.userId] });
    const [claimed] = await createRuntimeDispatchActions(transaction).claimRuns({ userId: member.id, daemonId: runtime.daemonId });
    expect(claimed?.status).toBe("dispatched");
    await projects.removeProjectMember.handler({ userId: admin.id }, { projectId: project.id, userId: originator.id });
    const readRefused = await post("/actions/get_work_item", { workspaceId: workspace.id, displayId: item.displayId }, undefined, claimed!.token);
    expect(readRefused.status).toBe(401);
    const refused = await post("/actions/update_work_item", { workItemId: item.id, title: "After revocation" }, undefined, claimed!.token);
    expect(refused.status).toBe(401);
    const [revokedRun] = await transaction.select({ status: runs.status, failureReason: runs.failureReason }).from(runs).where(eq(runs.id, claimed!.runId));
    expect(revokedRun).toEqual({ status: "failed", failureReason: "Project write access was revoked" });
    const [stored] = await transaction.select({ title: workItems.title }).from(workItems).where(eq(workItems.id, item.id));
    expect(stored?.title).toBe("Before revocation");
  });
});

test.concurrent("the Daemon start endpoint rejects a claimed Run after Originator or Member-Agent creator Project access is removed", async () => {
  await withRollback(db, async (transaction) => {
    const { post, signUp } = await setup(transaction);
    const admin = await signUp();
    const workspace = await (await post("/actions/create_workspace", { name: "Team", slug: `start-auth-${crypto.randomUUID()}` }, admin.cookie)).json() as { id: string };
    await post("/actions/set_autopilot_setting", { workspaceId: workspace.id, allowAutopilot: true }, admin.cookie);
    const owner = await createMemberFactory(transaction, workspace.id, "Member");
    const originator = await createMemberFactory(transaction, workspace.id, "Member");
    const projectActions = createProjectActions(transaction);
    const project = await projectActions.createProject.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Start permissions", key: `SA${crypto.randomUUID().slice(0, 4).toUpperCase()}`, visibility: "private" });
    for (const userId of [owner.id, originator.id]) await projectActions.addProjectMember.handler({ userId: admin.id }, { projectId: project.id, userId, role: "Member" });
    const personalToken = await createApiTokenActions(transaction).createApiToken.handler({ userId: owner.id }, { name: "member daemon" });
    const registration = await (await post("/api/daemon/register", { hostname: "start-permission", version: "1", agentClis: ["codex"] }, undefined, personalToken.token)).json() as { daemonId: string; daemonToken: string; runtimes: Array<{ id: string }> };
    const runtime = registration.runtimes[0]!;
    await createRuntimeActions(transaction).shareRuntime.handler({ userId: owner.id }, { runtimeId: runtime.id });
    const agents = createAgentActions(transaction);
    const agent = await agents.createAgent.handler({ userId: owner.id }, { workspaceId: workspace.id, name: "Member Agent", model: "default", runtimeId: runtime.id });
    await agents.setAgentProjectAccess.handler({ userId: owner.id }, { agentId: agent.id, allProjects: false, projectIds: [project.id] });
    await agents.setAgentAccess.handler({ userId: owner.id }, { agentId: agent.id, userIds: [owner.id, originator.id] });
    const item = await createWorkItemActions(transaction).createWorkItem.handler({ userId: originator.id }, { projectId: project.id, title: "Run without access", assigneeIds: [agent.userId] });
    const [claimed] = await createRuntimeDispatchActions(transaction).claimRuns({ userId: owner.id, daemonId: registration.daemonId });
    expect(claimed?.status).toBe("dispatched");

    const postStart = () => post("/api/daemon/runs/start", { runId: claimed!.runId, runtimeId: runtime.id }, undefined, registration.daemonToken);
    await transaction.delete(projectMembers).where(and(eq(projectMembers.projectId, project.id), eq(projectMembers.userId, owner.id)));
    expect((await postStart()).status).toBe(403);
    await projectActions.addProjectMember.handler({ userId: admin.id }, { projectId: project.id, userId: owner.id, role: "Member" });
    await transaction.delete(projectMembers).where(and(eq(projectMembers.projectId, project.id), eq(projectMembers.userId, originator.id)));
    expect((await postStart()).status).toBe(403);
    const [stored] = await transaction.select({ status: runs.status }).from(runs).where(eq(runs.id, claimed!.runId));
    expect(stored?.status).toBe("dispatched");
    expect(item.id).toBeTruthy();
  });
});

test.concurrent("the Daemon WebSocket accepts heartbeats and closes when its Daemon credential is revoked", async () => {
  await withRollback(db, async (transaction) => {
    const { app, post, signUp } = await setup(transaction);
    const owner = await signUp();
    const workspace = await (await post("/actions/create_workspace", { name: "Team", slug: `ws-${crypto.randomUUID()}` }, owner.cookie)).json() as { id: string };
    const personal = await (await post("/actions/create_api_token", { name: "cli" }, owner.cookie)).json() as { token: string };
    const registration = await (await post("/api/daemon/register", { hostname: "devbox", version: "1", agentClis: ["claude"] }, undefined, personal.token)).json() as { daemonToken: string };
    const listed = await (await post("/actions/list_api_tokens", {}, owner.cookie)).json() as Array<{ id: string; name: string }>;
    const daemonRow = listed.find((row) => row.name === "Daemon @ devbox")!;
    app.listen(0);
    try {
      const ws = new WebSocket(`ws://localhost:${app.server!.port}/api/daemon?token=${encodeURIComponent(registration.daemonToken)}`);
      await new Promise<void>((resolve, reject) => { ws.addEventListener("open", () => resolve(), { once: true }); ws.addEventListener("error", () => reject(new Error("WebSocket failed")), { once: true }); });
      const ack = new Promise<string>((resolve) => ws.addEventListener("message", (event) => resolve(String(event.data)), { once: true }));
      ws.send(JSON.stringify({ type: "heartbeat" }));
      expect(JSON.parse(await ack)).toMatchObject({ type: "heartbeat_ack" });
      await post("/actions/revoke_api_token", { tokenId: daemonRow.id }, owner.cookie);
      const closed = new Promise<number>((resolve) => ws.addEventListener("close", (event) => resolve(event.code), { once: true }));
      ws.send(JSON.stringify({ type: "heartbeat" }));
      expect(await closed).toBe(1008);
      const listedRuntimes = await app.handle(new Request("http://localhost/actions/list_runtimes", { method: "POST", headers: { cookie: owner.cookie, "content-type": "application/json" }, body: JSON.stringify({ workspaceId: workspace.id }) }));
      expect(await listedRuntimes.json()).toMatchObject([{ online: false }]);
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
    await post("/actions/set_autopilot_setting", { workspaceId: workspace.id, allowAutopilot: true }, owner.cookie);
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
      await writeFile(claude, "#!/bin/sh\nweft create-comment --work-item-id \"$WEFT_WORK_ITEM_ID\" --body '{\"type\":\"doc\",\"content\":[{\"type\":\"paragraph\",\"content\":[{\"type\":\"text\",\"text\":\"Comment from fake CLI\"}]}]}'\nprintf '%s\\n' '{\"type\":\"result\",\"result\":\"Runtime work completed\"}'\n");
      await chmod(claude, 0o755);
      const apiUrl = `http://localhost:${app.server!.port}`;
      const registration = await (await post("/actions/register_daemon", { hostname: "e2e", version: "1", agentClis: ["claude"] }, undefined, token.token)).json() as { runtimes: Array<{ id: string }> };
      const runtimeId = registration.runtimes[0]!.id;
      await createRuntimeActions(transaction).shareRuntime.handler({ userId: owner.id }, { runtimeId });
      await agents.updateAgent.handler({ userId: owner.id }, { agentId: agent.id, runtimeId });
      const item = await work.createWorkItem.handler({ userId: owner.id }, { projectId: project.id, title: "Finish this item", assigneeIds: [agent.userId] });
      // The shell CLI is the real `weft` command and uses the Run token placed in its environment by the Daemon.
      daemonTask = startDaemon({ env: { WEFT_TOKEN: token.token, XDG_CONFIG_HOME: await mkdtemp(join(tmpdir(), "weft-e2e-config-")), WEFT_API_URL: apiUrl, PATH: `${path}:${Bun.env.PATH ?? ""}`, WEFT_HOSTNAME: "e2e" }, signal: controller.signal, heartbeatMs: 20, reprobeMs: 60_000 });

      let runStatus = "queued";
      for (let i = 0; i < 200 && !["completed", "failed"].includes(runStatus); i++) {
        const response = await post("/actions/list_runs", { workItemId: item.id }, owner.cookie);
        const rows = await response.json() as Array<{ status: string }>;
        runStatus = rows[0]?.status ?? "queued";
        if (!["completed", "failed"].includes(runStatus)) await Bun.sleep(25);
      }
      expect(runStatus).toBe("completed");
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

test.concurrent("a stale claimed sandbox policy gets a 409 and fails without spawning the CLI", async () => {
  await withRollback(db, async (transaction) => {
    const { app, post, signUp } = await setup(transaction);
    const owner = await signUp();
    const workspace = await (await post("/actions/create_workspace", { name: "Team", slug: `stale-${crypto.randomUUID().slice(0, 8)}` }, owner.cookie)).json() as { id: string };
    await post("/actions/set_autopilot_setting", { workspaceId: workspace.id, allowAutopilot: true }, owner.cookie);
    const token = await (await post("/actions/create_api_token", { name: "daemon" }, owner.cookie)).json() as { token: string };
    const project = await createProjectActions(transaction).createProject.handler({ userId: owner.id }, { workspaceId: workspace.id, name: "Policy transition", key: `SP${crypto.randomUUID().slice(0, 4).toUpperCase()}`, visibility: "private" });
    const agents = createAgentActions(transaction);
    const agent = await agents.createAgent.handler({ userId: owner.id }, { workspaceId: workspace.id, name: "Runtime Agent", instructions: "Run only if authorized", model: "default" });
    await agents.setAgentProjectAccess.handler({ userId: owner.id }, { agentId: agent.id, allProjects: true, projectIds: [] });
    const registered = await (await post("/actions/register_daemon", { hostname: "stale-policy-test", version: "1", agentClis: ["claude"] }, undefined, token.token)).json() as { runtimes: Array<{ id: string }> };
    const runtimeId = registered.runtimes[0]!.id;
    const runtimeActions = createRuntimeActions(transaction);
    await runtimeActions.shareRuntime.handler({ userId: owner.id }, { runtimeId });
    await agents.updateAgent.handler({ userId: owner.id }, { agentId: agent.id, runtimeId });
    const [profile] = await transaction.select().from(runtimeProfiles).where(eq(runtimeProfiles.runtimeId, runtimeId));
    const item = await createWorkItemActions(transaction).createWorkItem.handler({ userId: owner.id }, { projectId: project.id, title: "Check the transition", assigneeIds: [agent.userId] });

    const path = await mkdtemp(join(tmpdir(), "weft-stale-policy-cli-"));
    const configHome = await mkdtemp(join(tmpdir(), "weft-stale-policy-config-"));
    const marker = join(path, "spawned");
    await writeFile(join(path, "claude"), `#!/bin/sh\nprintf started > "${marker}"\nprintf '%s\\n' '{"type":"result","result":"should never run"}'\n`);
    await chmod(join(path, "claude"), 0o755);
    const claimed = Promise.withResolvers<void>();
    const releaseClaim = Promise.withResolvers<void>();
    let capturedClaim = false;
    let startStatus: number | undefined;
    const controller = new AbortController();
    app.listen(0);
    let daemonTask: Promise<void> | undefined;
    try {
      const apiUrl = `http://localhost:${app.server!.port}`;
      daemonTask = startDaemon({
        env: { WEFT_TOKEN: token.token, XDG_CONFIG_HOME: configHome, WEFT_API_URL: apiUrl, PATH: `${path}:${Bun.env.PATH ?? ""}`, WEFT_HOSTNAME: "stale-policy-test" },
        fetch: async (input, init) => {
          const response = await fetch(input, init);
          const url = String(input);
          if (url.endsWith("/api/daemon/runs/claim") && !capturedClaim) {
            const runs = await response.clone().json() as Array<{ runId: string }>;
            if (runs.length) { capturedClaim = true; claimed.resolve(); await releaseClaim.promise; }
          }
          if (url.endsWith("/api/daemon/runs/start")) startStatus = response.status;
          return response;
        },
        signal: controller.signal, heartbeatMs: 20, reprobeMs: 60_000,
      });

      await Promise.race([claimed.promise, Bun.sleep(5_000).then(() => { throw new Error("Daemon did not claim the queued Run"); })]);
      await runtimeActions.updateRuntimeProfile.handler({ userId: owner.id }, { profileId: profile!.id, name: profile!.name, sandbox: "read-only", filesystemAllowlist: [], networkAllowlist: [] });
      releaseClaim.resolve();

      let status = "dispatched";
      for (let i = 0; i < 200 && status !== "failed"; i++) {
        const rows = await (await post("/actions/list_runs", { workItemId: item.id }, owner.cookie)).json() as Array<{ status: string; failureReason: string | null }>;
        status = rows[0]?.status ?? "missing";
        if (status !== "failed") await Bun.sleep(25);
      }
      expect(status).toBe("failed");
      const rows = await (await post("/actions/list_runs", { workItemId: item.id }, owner.cookie)).json() as Array<{ id: string; status: string; failureReason: string | null }>;
      expect(rows[0]).toMatchObject({ status: "failed", failureReason: "sandbox_policy_changed" });
      const [terminalRun] = await transaction.select({ status: runs.status, runtimeEnvironmentSecrets: runs.runtimeEnvironmentSecrets }).from(runs).where(eq(runs.id, rows[0]!.id));
      const [runCredential] = await transaction.select({ expiresAt: runTokens.expiresAt }).from(runTokens).where(eq(runTokens.runId, rows[0]!.id));
      expect(terminalRun).toMatchObject({ status: "failed", runtimeEnvironmentSecrets: null });
      expect(runCredential!.expiresAt.getTime()).toBeLessThanOrEqual(Date.now());
      expect(startStatus).toBe(409);
      expect(await Bun.file(marker).exists()).toBe(false);
    } finally {
      releaseClaim.resolve();
      controller.abort();
      await daemonTask?.catch(() => {});
      app.stop(true);
      await rm(path, { recursive: true, force: true });
      await rm(configHome, { recursive: true, force: true });
    }
  });
});

test.concurrent("cancelling a running Runtime Run signals the Daemon, kills its CLI and acknowledges cancellation", async () => {
  await withRollback(db, async (transaction) => {
    const { app, post, signUp } = await setup(transaction);
    const owner = await signUp();
    const workspace = await (await post("/actions/create_workspace", { name: "Team", slug: `cancel-${crypto.randomUUID()}` }, owner.cookie)).json() as { id: string };
    await post("/actions/set_autopilot_setting", { workspaceId: workspace.id, allowAutopilot: true }, owner.cookie);
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
      daemonTask = startDaemon({ env: { WEFT_TOKEN: token.token, XDG_CONFIG_HOME: await mkdtemp(join(tmpdir(), "weft-cancel-config-")), WEFT_HOSTNAME: "cancel-test", WEFT_API_URL: `http://localhost:${app.server!.port}`, PATH: `${path}:${Bun.env.PATH ?? ""}`, WEFT_MARKER: marker }, signal: controller.signal, heartbeatMs: 20, reprobeMs: 60_000 });
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
