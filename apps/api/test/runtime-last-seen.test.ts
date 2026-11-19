import { afterAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createDatabase, runtimes, type Database } from "@weft/db";
import { createRuntimeActions } from "@weft/actions";
import { withRollback } from "../../../packages/db/src/test-helpers";
import { createApp } from "../src/app";

const { client, db } = createDatabase();
afterAll(async () => client.end());

/** One app with a clock the test moves by hand: the last-seen time, freshness and the offline seconds all read it. */
function harness(transaction: Database, start: string) {
  const clock = { at: Date.parse(start) };
  const now = () => new Date(clock.at);
  const app = createApp(undefined, transaction, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, now);
  const post = (path: string, body: unknown, cookie?: string, token?: string) => app.handle(new Request(`http://localhost${path}`, {
    method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
  }));
  const signUp = async () => {
    const response = await post("/api/auth/sign-up/email", { name: "Dev", email: `${crypto.randomUUID()}@example.test`, password: "a-secure-password" });
    const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
    const me = await (await app.handle(new Request("http://localhost/api/me", { headers: { cookie } }))).json() as { user: { id: string } };
    return { cookie, id: me.user.id };
  };
  return { app, clock, now, post, signUp };
}

type ListedRuntime = { id: string; agentCli: string; online: boolean; lastSeenAt: string; offlineSeconds: number | null };

async function listRuntimes(app: ReturnType<typeof harness>["app"], cookie: string, workspaceId: string) {
  const response = await app.handle(new Request("http://localhost/actions/list_runtimes", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ workspaceId }) }));
  return await response.json() as ListedRuntime[];
}

const EPOCH = "1970-01-01T00:00:00.000Z";

test.concurrent("a Daemon whose credential is revoked keeps the real last-seen time of its Runtimes, and the list counts the offline seconds from it", async () => {
  await withRollback(db, async (transaction) => {
    const { app, clock, post, signUp } = harness(transaction, "2026-11-18T09:00:00.000Z");
    const owner = await signUp();
    const workspace = await (await post("/actions/create_workspace", { name: "Team", slug: `rls-${crypto.randomUUID()}` }, owner.cookie)).json() as { id: string };
    const personal = await (await post("/actions/create_api_token", { name: "cli" }, owner.cookie)).json() as { token: string };
    const registration = await (await post("/api/daemon/register", { hostname: "devbox", version: "1", agentClis: ["claude", "codex"] }, undefined, personal.token)).json() as { daemonToken: string };
    const listed = await (await post("/actions/list_api_tokens", {}, owner.cookie)).json() as Array<{ id: string; name: string }>;
    const daemonRow = listed.find((row) => row.name === "Daemon @ devbox")!;
    const registeredAt = clock.at;
    app.listen(0);
    try {
      const ws = new WebSocket(`ws://localhost:${app.server!.port}/api/daemon?token=${encodeURIComponent(registration.daemonToken)}`);
      await new Promise<void>((resolve, reject) => { ws.addEventListener("open", () => resolve(), { once: true }); ws.addEventListener("error", () => reject(new Error("WebSocket failed")), { once: true }); });
      const closed = new Promise<number>((resolve) => ws.addEventListener("close", (event) => resolve(event.code), { once: true }));
      await post("/actions/revoke_api_token", { tokenId: daemonRow.id }, owner.cookie);
      ws.send(JSON.stringify({ type: "heartbeat" }));
      expect(await closed).toBe(1008);
    } finally {
      app.stop(true);
    }
    clock.at += 200_000;
    const offline = await listRuntimes(app, owner.cookie, workspace.id);
    expect(offline.map((runtime) => [runtime.online, runtime.offlineSeconds, runtime.lastSeenAt])).toEqual([
      [false, 200, new Date(registeredAt).toISOString()],
      [false, 200, new Date(registeredAt).toISOString()],
    ]);
  });
});

test.concurrent("a Runtime whose agent CLI is no longer detected keeps its last-seen time, stays offline through heartbeats, and comes back when the CLI is detected again", async () => {
  await withRollback(db, async (transaction) => {
    const { app, clock, now, post, signUp } = harness(transaction, "2026-11-18T09:00:00.000Z");
    const owner = await signUp();
    const workspace = await (await post("/actions/create_workspace", { name: "Team", slug: `cli-${crypto.randomUUID()}` }, owner.cookie)).json() as { id: string };
    const personal = await (await post("/actions/create_api_token", { name: "cli" }, owner.cookie)).json() as { token: string };
    const first = await (await post("/api/daemon/register", { hostname: "devbox", version: "1", agentClis: ["claude", "codex"] }, undefined, personal.token)).json() as { daemonId: string; runtimes: ListedRuntime[] };
    const claudeSeenAt = clock.at;
    clock.at += 60_000;
    await post("/api/daemon/register", { hostname: "devbox", version: "1", agentClis: ["codex"] }, undefined, personal.token);
    clock.at += 140_000;
    const offline = await listRuntimes(app, owner.cookie, workspace.id);
    const claude = offline.find((runtime) => runtime.agentCli === "claude")!;
    const codex = offline.find((runtime) => runtime.agentCli === "codex")!;
    expect([claude.online, claude.offlineSeconds, claude.lastSeenAt]).toEqual([false, 200, new Date(claudeSeenAt).toISOString()]);
    expect(codex.online).toBe(true);
    // A heartbeat keeps the detected CLI online and does not revive the CLI that is gone.
    await createRuntimeActions(transaction, now).heartbeat({ userId: owner.id }, first.daemonId);
    const afterHeartbeat = await listRuntimes(app, owner.cookie, workspace.id);
    expect(afterHeartbeat.find((runtime) => runtime.agentCli === "claude")).toMatchObject({ online: false, offlineSeconds: 200 });
    expect(afterHeartbeat.find((runtime) => runtime.agentCli === "codex")!.online).toBe(true);
    // Detecting the CLI again brings the same Runtime back online, with no offline time.
    await post("/api/daemon/register", { hostname: "devbox", version: "1", agentClis: ["claude", "codex"] }, undefined, personal.token);
    const back = await listRuntimes(app, owner.cookie, workspace.id);
    expect(back.find((runtime) => runtime.agentCli === "claude")).toMatchObject({ id: claude.id, online: true, offlineSeconds: null });
  });
});

test.concurrent("a Runtime whose offline time is unknown, reset to the epoch before, reports unknown however long it stays offline, and a heartbeat does not revive it", async () => {
  await withRollback(db, async (transaction) => {
    const { app, clock, now, post, signUp } = harness(transaction, "2026-11-18T09:00:00.000Z");
    const owner = await signUp();
    const workspace = await (await post("/actions/create_workspace", { name: "Team", slug: `unk-${crypto.randomUUID()}` }, owner.cookie)).json() as { id: string };
    const personal = await (await post("/actions/create_api_token", { name: "cli" }, owner.cookie)).json() as { token: string };
    const registered = await (await post("/api/daemon/register", { hostname: "devbox", version: "1", agentClis: ["claude"] }, undefined, personal.token)).json() as { daemonId: string };
    await transaction.update(runtimes).set({ lastSeenAt: new Date(0) }).where(eq(runtimes.workspaceId, workspace.id));
    clock.at += 10 * 24 * 3600_000;
    await createRuntimeActions(transaction, now).heartbeat({ userId: owner.id }, registered.daemonId);
    const [listed] = await listRuntimes(app, owner.cookie, workspace.id);
    expect(listed).toMatchObject({ online: false, offlineSeconds: null, lastSeenAt: EPOCH });
  });
});
