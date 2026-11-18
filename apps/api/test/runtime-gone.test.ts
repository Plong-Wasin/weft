import { afterAll, expect, test } from "bun:test";
import { createApiTokenActions } from "@weft/actions";
import { createDatabase, type Database } from "@weft/db";
import { withRollback } from "../../../packages/db/src/test-helpers";
import { createApp } from "../src/app";

const { client, db } = createDatabase();
afterAll(async () => client.end());

function setup(transaction: Database) {
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
  const listRuntimes = async (cookie: string, workspaceId: string) => await (await app.handle(new Request("http://localhost/actions/list_runtimes", {
    method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ workspaceId }),
  }))).json() as Array<{ id: string; online: boolean; agentCli: string }>;
  return { app, post, signUp, listRuntimes };
}

type Registered = { daemonId: string; runtimes: Array<{ id: string; agentCli: string; shared: boolean; profiles?: unknown }> };

/** An owner with a workspace and a Daemon registered for claude and codex, over the Personal API token the CLI uses. */
async function registerOwner(transaction: Database, post: ReturnType<typeof setup>["post"], signUp: ReturnType<typeof setup>["signUp"]) {
  const owner = await signUp();
  const workspace = await (await post("/actions/create_workspace", { name: "Team", slug: `gone-${crypto.randomUUID()}` }, owner.cookie)).json() as { id: string };
  const personal = await createApiTokenActions(transaction).createApiToken.handler({ userId: owner.id }, { name: "cli" });
  const registration = await (await post("/api/daemon/register", { hostname: "devbox", version: "1", agentClis: ["claude", "codex"] }, undefined, personal.token)).json() as Registered & { daemonToken: string };
  return { owner, workspace, personal, registration };
}

/** A Daemon WebSocket whose frames are read in order: the tests wait for the next acknowledgement, not for a fixed time. */
async function daemonSocket(app: ReturnType<typeof setup>["app"], daemonToken: string) {
  app.listen(0);
  const ws = new WebSocket(`ws://localhost:${app.server!.port}/api/daemon?token=${encodeURIComponent(daemonToken)}`);
  const inbox: Array<{ type: string; goneRuntimeIds?: string[] }> = [];
  let wake: (() => void) | undefined;
  ws.addEventListener("message", (event) => { inbox.push(JSON.parse(String(event.data))); wake?.(); });
  await new Promise<void>((resolve, reject) => { ws.addEventListener("open", () => resolve(), { once: true }); ws.addEventListener("error", () => reject(new Error("WebSocket failed")), { once: true }); });
  return {
    /** Sends a heartbeat that names the Runtime ids the Daemon holds, and returns the acknowledgement it gets back. */
    heartbeat: async (runtimeIds: string[]) => {
      ws.send(JSON.stringify({ type: "heartbeat", runtimeIds }));
      while (!inbox.some((frame) => frame.type === "heartbeat_ack")) await new Promise<void>((resolve) => { wake = resolve; });
      return inbox.splice(inbox.findIndex((frame) => frame.type === "heartbeat_ack"), 1)[0]!;
    },
    close: () => { ws.close(); app.stop(true); },
  };
}

test.concurrent("the heartbeat acknowledgement names only the Runtime ids the Daemon registered that were deleted", async () => {
  await withRollback(db, async (transaction) => {
    const { app, post, signUp, listRuntimes } = setup(transaction);
    const { owner, workspace, personal, registration } = await registerOwner(transaction, post, signUp);
    const claude = registration.runtimes.find((runtime) => runtime.agentCli === "claude")!;
    const codex = registration.runtimes.find((runtime) => runtime.agentCli === "codex")!;
    const socket = await daemonSocket(app, registration.daemonToken);
    try {
      expect(await socket.heartbeat([claude.id, codex.id])).toMatchObject({ type: "heartbeat_ack", goneRuntimeIds: [] });
      expect((await post("/actions/delete_runtime", { runtimeId: codex.id }, owner.cookie)).status).toBe(200);
      expect(await socket.heartbeat([claude.id, codex.id])).toMatchObject({ type: "heartbeat_ack", goneRuntimeIds: [codex.id] });
    } finally {
      socket.close();
    }
    expect((await listRuntimes(owner.cookie, workspace.id)).map((runtime) => runtime.id)).toEqual([claude.id]);
  });
});

test.concurrent("deleting the codex Runtime of a Daemon leaves its claude Runtime online and working", async () => {
  await withRollback(db, async (transaction) => {
    const { app, post, signUp, listRuntimes } = setup(transaction);
    const { owner, workspace, personal, registration } = await registerOwner(transaction, post, signUp);
    const claude = registration.runtimes.find((runtime) => runtime.agentCli === "claude")!;
    const codex = registration.runtimes.find((runtime) => runtime.agentCli === "codex")!;
    expect((await post("/actions/delete_runtime", { runtimeId: codex.id }, owner.cookie)).status).toBe(200);
    const socket = await daemonSocket(app, registration.daemonToken);
    try {
      // The Daemon keeps heartbeating with the claude Runtime: the codex one is named once, and the claude one is not.
      expect(await socket.heartbeat([claude.id, codex.id])).toMatchObject({ goneRuntimeIds: [codex.id] });
      expect(await socket.heartbeat([claude.id])).toMatchObject({ type: "heartbeat_ack", goneRuntimeIds: [] });
    } finally {
      socket.close();
    }
    expect(await listRuntimes(owner.cookie, workspace.id)).toMatchObject([{ id: claude.id, agentCli: "claude", online: true }]);
  });
});

test.concurrent("registering again after a delete returns a new private Runtime with only the starting Full access profile", async () => {
  await withRollback(db, async (transaction) => {
    const { app, post, signUp } = setup(transaction);
    const { owner, workspace, personal, registration } = await registerOwner(transaction, post, signUp);
    const claude = registration.runtimes.find((runtime) => runtime.agentCli === "claude")!;
    expect((await post("/actions/share_runtime", { runtimeId: claude.id }, owner.cookie)).status).toBe(200);
    expect((await post("/actions/create_runtime_profile", { runtimeId: claude.id, name: "Read only", sandbox: "read-only", filesystemAllowlist: [], networkAllowlist: [] }, owner.cookie)).status).toBe(200);
    expect((await post("/actions/delete_runtime", { runtimeId: claude.id }, owner.cookie)).status).toBe(200);
    const again = await (await post("/api/daemon/register", { hostname: "devbox", version: "1", agentClis: ["claude", "codex"] }, undefined, personal.token)).json() as Registered;
    const fresh = again.runtimes.find((runtime) => runtime.agentCli === "claude")!;
    expect(fresh.id).not.toBe(claude.id);
    expect(fresh.shared).toBe(false);
    const profiles = await (await post("/actions/list_runtime_profiles", { runtimeId: fresh.id }, owner.cookie)).json() as Array<{ name: string; sandbox: string }>;
    expect(profiles.map((profile) => ({ name: profile.name, sandbox: profile.sandbox }))).toEqual([{ name: "Full access", sandbox: "full" }]);
    const listed = await (await post("/actions/list_runtimes", { workspaceId: workspace.id }, owner.cookie)).json() as Array<{ id: string; agents: unknown[]; shared: boolean }>;
    expect(listed.find((runtime) => runtime.id === fresh.id)).toMatchObject({ agents: [], shared: false });
    expect(listed.map((runtime) => runtime.id)).not.toContain(claude.id);
  });
});
