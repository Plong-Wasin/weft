import { afterAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { apiTokens, createDatabase, type Database } from "@weft/db";
import { withRollback } from "../../../packages/db/src/test-helpers";
import { createApp } from "../src/app";

const { client, db } = createDatabase();
afterAll(async () => client.end());

function setup(transaction: Database) {
  const app = createApp(undefined, transaction);
  const call = (path: string, body: unknown, options: { cookie?: string; bearer?: string } = {}) => app.handle(new Request(`http://localhost${path}`, {
    method: "POST", headers: { "content-type": "application/json", ...(options.cookie ? { cookie: options.cookie } : {}), ...(options.bearer ? { authorization: `Bearer ${options.bearer}` } : {}) }, body: JSON.stringify(body),
  }));
  const signUp = async () => {
    const response = await call("/api/auth/sign-up/email", { name: "Dev", email: `${crypto.randomUUID()}@example.test`, password: "a-secure-password" });
    const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
    const me = await (await app.handle(new Request("http://localhost/api/me", { headers: { cookie } }))).json() as { user: { id: string } };
    return { cookie, id: me.user.id };
  };
  const signIn = async (cookie: string, hostname: string) => {
    const query = new URLSearchParams({ callback: "http://127.0.0.1:43210/callback", state: crypto.randomUUID(), hostname });
    const response = await app.handle(new Request(`http://localhost/api/cli/login?${query}`, { headers: { cookie } }));
    return new URL(response.headers.get("location")!).searchParams.get("token")!;
  };
  return { app, call, signUp, signIn };
}

test.concurrent("weft login issues a normal Personal API token that calls /actions and is not a Daemon credential", async () => {
  await withRollback(db, async (transaction) => {
    const { call, signUp, signIn } = setup(transaction);
    const owner = await signUp();
    const workspace = await (await call("/actions/create_workspace", { name: "Team", slug: `cli-${crypto.randomUUID()}` }, { cookie: owner.cookie })).json() as { id: string };
    const cli = await signIn(owner.cookie, "devbox");
    expect(cli).toStartWith("weft_");
    expect(cli).not.toStartWith("weft_daemon_");
    const projects = await call("/actions/list_projects", { workspaceId: workspace.id }, { bearer: cli });
    expect(projects.status).toBe(200);
    expect((await call("/api/daemon/runs/claim", {}, { bearer: cli })).status).toBe(401);
    const listed = await (await call("/actions/list_api_tokens", {}, { cookie: owner.cookie })).json() as Array<{ name: string; status: string; expiresAt: string | null }>;
    const [row] = listed.filter((entry) => entry.name === "CLI @ devbox");
    expect(row?.status).toBe("active");
    expect(Date.parse(row!.expiresAt!) - Date.now()).toBeGreaterThan(29 * 24 * 60 * 60 * 1000);
    expect(Date.parse(row!.expiresAt!) - Date.now()).toBeLessThanOrEqual(30 * 24 * 60 * 60 * 1000);
    // A second sign-in on the same machine replaces the first token.
    const again = await signIn(owner.cookie, "devbox");
    expect((await call("/actions/list_projects", { workspaceId: workspace.id }, { bearer: cli })).status).toBe(401);
    expect((await call("/actions/list_projects", { workspaceId: workspace.id }, { bearer: again })).status).toBe(200);
  });
});

test.concurrent("register_daemon with a Personal token leaves it usable, issues one Daemon credential, and the Daemon credential only reaches /api/daemon/*", async () => {
  await withRollback(db, async (transaction) => {
    const { call, signUp } = setup(transaction);
    const owner = await signUp();
    const workspace = await (await call("/actions/create_workspace", { name: "Team", slug: `dc-${crypto.randomUUID()}` }, { cookie: owner.cookie })).json() as { id: string };
    const personal = (await (await call("/actions/create_api_token", { name: "cli" }, { cookie: owner.cookie })).json() as { token: string }).token;
    const first = await (await call("/api/daemon/register", { hostname: "devbox", version: "1", agentClis: ["claude"] }, { bearer: personal })).json() as { daemonId: string; runtimes: Array<{ id: string }>; daemonToken?: string };
    expect(first.daemonToken).toStartWith("weft_daemon_");
    const second = await (await call("/api/daemon/register", { hostname: "devbox", version: "1", agentClis: ["claude"] }, { bearer: personal })).json() as { daemonId: string; runtimes: Array<{ id: string }>; daemonToken?: string };
    expect(second.daemonToken).toBeUndefined();
    expect(second.daemonId).toBe(first.daemonId);
    expect(second.runtimes.map((runtime) => runtime.id)).toEqual(first.runtimes.map((runtime) => runtime.id));
    // The Personal token keeps working for /actions after registrations.
    expect((await call("/actions/list_projects", { workspaceId: workspace.id }, { bearer: personal })).status).toBe(200);
    const daemon = first.daemonToken!;
    expect((await call("/api/daemon/runs/claim", {}, { bearer: daemon })).status).toBe(200);
    // Negative: the Daemon credential cannot call /actions, and cannot register again.
    expect((await call("/actions/list_projects", { workspaceId: workspace.id }, { bearer: daemon })).status).toBe(401);
    expect((await call("/api/daemon/register", { hostname: "devbox", version: "1", agentClis: ["claude"] }, { bearer: daemon })).status).toBe(401);
  });
});

test.concurrent("a Daemon credential under 7 days left rotates, revokes the old one, and keeps the Daemon and its Runtimes", async () => {
  await withRollback(db, async (transaction) => {
    const { call, signUp } = setup(transaction);
    const owner = await signUp();
    const personal = (await (await call("/actions/create_api_token", { name: "cli" }, { cookie: owner.cookie })).json() as { token: string }).token;
    const first = await (await call("/api/daemon/register", { hostname: "devbox", version: "1", agentClis: ["claude", "codex"] }, { bearer: personal })).json() as { daemonId: string; runtimes: Array<{ id: string }>; daemonToken: string };
    // Put the credential 6 days from expiry: the next registration rotates it.
    const listed = await (await call("/actions/list_api_tokens", {}, { cookie: owner.cookie })).json() as Array<{ id: string; name: string }>;
    const oldRow = listed.find((entry) => entry.name === "Daemon @ devbox")!;
    await transaction.update(apiTokens).set({ expiresAt: new Date(Date.now() + 6 * 24 * 60 * 60 * 1000) }).where(eq(apiTokens.id, oldRow.id));
    const rotated = await (await call("/api/daemon/register", { hostname: "devbox", version: "1", agentClis: ["claude", "codex"] }, { bearer: personal })).json() as { daemonId: string; runtimes: Array<{ id: string }>; daemonToken?: string };
    expect(rotated.daemonToken).toStartWith("weft_daemon_");
    expect(rotated.daemonToken).not.toBe(first.daemonToken);
    expect(rotated.daemonId).toBe(first.daemonId);
    expect(rotated.runtimes.map((runtime) => runtime.id).sort()).toEqual(first.runtimes.map((runtime) => runtime.id).sort());
    // The old credential keeps working for the 10-minute grace period; daemon-rotation.test.ts covers its expiry.
    expect((await call("/api/daemon/runs/claim", {}, { bearer: first.daemonToken })).status).toBe(200);
    expect((await call("/api/daemon/runs/claim", {}, { bearer: rotated.daemonToken })).status).toBe(200);
  });
});

test.concurrent("register_daemon refuses a Daemon credential as the caller", async () => {
  await withRollback(db, async (transaction) => {
    const { call, signUp } = setup(transaction);
    const owner = await signUp();
    const personal = (await (await call("/actions/create_api_token", { name: "cli" }, { cookie: owner.cookie })).json() as { token: string }).token;
    const registered = await (await call("/api/daemon/register", { hostname: "devbox", version: "1", agentClis: [] }, { bearer: personal })).json() as { daemonToken: string };
    expect((await call("/actions/register_daemon", { hostname: "devbox", version: "1", agentClis: [] }, { bearer: registered.daemonToken })).status).toBe(401);
  });
});
