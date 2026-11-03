import { afterAll, expect, test } from "bun:test";
import { createDatabase, type Database } from "@weft/db";
import { withRollback } from "../../../packages/db/src/test-helpers";
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
