import { afterAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createAgentActions, createApiTokenActions, mintApiToken, createProjectActions, createRuntimeActions, createWorkItemActions, type Mailer } from "@weft/actions";
import { createDatabase } from "@weft/db";
import { withRollback } from "../../../packages/db/src/test-helpers";
import { createApp } from "../src/app";
import { DEFAULT_RATE_LIMITS, RATE_LIMIT_VARIABLES, rateLimitSettings, type RateLimitSettings } from "../src/rate-limits";

const { client, db } = createDatabase();
afterAll(async () => client.end());

const PASSWORD = "correct-horse-battery-9";
const MINUTE = 60_000;
const mailer = { send: async () => undefined } as unknown as Mailer;
type Transaction = NonNullable<Parameters<typeof createApp>[1]>;

/** One app with its own clock, so waits and locks end by moving time instead of sleeping. */
function harness(transaction: Transaction, settings: Partial<RateLimitSettings> = {}, trustedProxyHops = 0) {
  const clock = { at: Date.parse("2026-11-13T09:00:00Z") };
  const app = createApp(undefined, transaction, { allowSignup: true, allowWorkspaceCreation: true }, undefined, undefined, { trustedProxyHops }, { online: false },
    undefined, mailer, undefined, undefined, { settings, now: () => clock.at });
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) => app.handle(new Request(`http://localhost${path}`, {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
  }));
  const signUp = (email: string, headers: Record<string, string> = {}) => post("/api/auth/sign-up/email", { name: "Ada", email, password: PASSWORD }, headers);
  const signIn = (email: string, password: string, headers: Record<string, string> = {}) => post("/api/auth/sign-in/email", { email, password }, headers);
  return { app, clock, post, signUp, signIn };
}

const newEmail = () => `${crypto.randomUUID()}@example.test`;

test("five wrong passwords lock the account for 15 minutes, and the right password works again after the lock", async () => {
  await withRollback(db, async (transaction) => {
    const { clock, signUp, signIn } = harness(transaction);
    const email = newEmail();
    expect((await signUp(email)).status).toBe(200);
    for (let attempt = 0; attempt < 5; attempt++) {
      expect((await signIn(email, "wrong-password-1")).status).toBe(401);
      clock.at += 31_000;
    }
    const locked = await signIn(email, PASSWORD);
    expect(locked.status).toBe(429);
    expect(await locked.json()).toMatchObject({ code: "SIGN_IN_LOCKED" });
    expect(Number(locked.headers.get("retry-after"))).toBeGreaterThan(0);
    clock.at += 10 * MINUTE;
    expect((await signIn(email, PASSWORD)).status).toBe(429);
    clock.at += 5 * MINUTE + 1_000;
    expect((await signIn(email, PASSWORD)).status).toBe(200);
  });
});

test("after three failures the next attempt waits; a refused attempt is not counted, and the account is allowed again after the wait", async () => {
  await withRollback(db, async (transaction) => {
    const { clock, signUp, signIn } = harness(transaction);
    const email = newEmail();
    await signUp(email);
    for (let attempt = 0; attempt < 3; attempt++) {
      expect((await signIn(email, "wrong-password-1")).status).toBe(401);
      if (attempt < 2) clock.at += 31_000;
    }
    const waiting = await signIn(email, "wrong-password-1");
    expect(waiting.status).toBe(429);
    expect(await waiting.json()).toMatchObject({ code: "SIGN_IN_WAIT", retryAfterSeconds: 2 });
    expect(waiting.headers.get("retry-after")).toBe("2");
    clock.at += 2_000;
    expect((await signIn(email, "wrong-password-1")).status).toBe(401);
  });
});

test("sign-in cannot skip the account lock with a form body, a trailing slash or another path spelling", async () => {
  await withRollback(db, async (transaction) => {
    const { app, clock, signUp, signIn } = harness(transaction);
    const email = newEmail();
    await signUp(email);
    for (let attempt = 0; attempt < 5; attempt++) { expect((await signIn(email, "wrong-password-1")).status).toBe(401); clock.at += 31_000; }
    expect((await signIn(email, PASSWORD)).status).toBe(429);
    const send = (path: string, contentType: string, body: string) => app.handle(new Request(`http://localhost${path}`, { method: "POST", headers: { "content-type": contentType }, body }));
    const form = new URLSearchParams({ email, password: PASSWORD }).toString();
    expect((await send("/api/auth/sign-in/email", "application/x-www-form-urlencoded", form)).status).toBe(415);
    expect((await send("/api/auth/sign-in/email/", "application/json", JSON.stringify({ email, password: PASSWORD }))).status).toBe(429);
    expect((await send("/api/auth/sign-in/email/", "application/x-www-form-urlencoded", form)).status).toBe(415);
    expect((await send("/api/auth/Sign-In/Email", "application/json", JSON.stringify({ email, password: PASSWORD }))).status).toBe(429);
    expect((await send("/api/auth/sign-in/email", "text/plain", JSON.stringify({ email, password: PASSWORD }))).status).toBe(415);
  });
});

test("a refusal never reveals whether the account exists: wrong-password and locked answers match for a real and an unknown email", async () => {
  await withRollback(db, async (transaction) => {
    const { clock, signUp, signIn } = harness(transaction);
    const real = newEmail();
    const unknown = newEmail();
    await signUp(real);
    const wrongReal = await signIn(real, "wrong-password-1");
    const wrongUnknown = await signIn(unknown, "wrong-password-1");
    expect(wrongReal.status).toBe(wrongUnknown.status);
    expect(await wrongReal.text()).toBe(await wrongUnknown.text());
    // Both emails fail on the same tick, so both locks end at the same time and the minute count matches.
    for (let attempt = 0; attempt < 4; attempt++) {
      clock.at += 31_000;
      await signIn(real, "wrong-password-1");
      await signIn(unknown, "wrong-password-1");
    }
    clock.at += 31_000;
    await signIn(real, "wrong-password-1");
    await signIn(unknown, "wrong-password-1");
    const lockedReal = await signIn(real, PASSWORD);
    const lockedUnknown = await signIn(unknown, PASSWORD);
    const realBody = await lockedReal.json() as Record<string, unknown>;
    const unknownBody = await lockedUnknown.json() as Record<string, unknown>;
    expect(lockedReal.status).toBe(429);
    expect(lockedUnknown.status).toBe(429);
    expect({ ...realBody, retryAfterSeconds: 0 }).toEqual({ ...unknownBody, retryAfterSeconds: 0 });
    expect(JSON.stringify(unknownBody)).not.toContain(unknown);
  });
});

test("failures from one address lock that address for every account, and another address still signs in", async () => {
  await withRollback(db, async (transaction) => {
    const { signUp, signIn } = harness(transaction, { signInAddressMaxFailures: 3, signInMaxFailures: 100 }, 1);
    const attacker = { "x-forwarded-for": "203.0.113.9" };
    const legit = { "x-forwarded-for": "198.51.100.7" };
    const accounts = [newEmail(), newEmail(), newEmail(), newEmail()];
    for (const email of accounts) await signUp(email, legit);
    for (const email of accounts.slice(0, 3)) expect((await signIn(email, "wrong-password-1", attacker)).status).toBe(401);
    const refused = await signIn(accounts[3]!, PASSWORD, attacker);
    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({ code: "SIGN_IN_LOCKED" });
    expect((await signIn(accounts[3]!, PASSWORD, legit)).status).toBe(200);
  });
});

test("sign-up and password reset are limited per address, and a reset answers the same for a known and an unknown email", async () => {
  await withRollback(db, async (transaction) => {
    const { post, signUp } = harness(transaction, { signUpPerAddressPerHour: 2, resetPerAddressPerHour: 2 });
    const known = newEmail();
    expect((await signUp(known)).status).toBe(200);
    expect((await signUp(newEmail())).status).toBe(200);
    const signUpLimited = await signUp(newEmail());
    expect(signUpLimited.status).toBe(429);
    expect(await signUpLimited.json()).toMatchObject({ code: "SIGN_UP_LIMITED" });
    expect(Number(signUpLimited.headers.get("retry-after"))).toBeGreaterThan(0);

    const resetKnown = await post("/api/auth/request-password-reset", { email: known, redirectTo: "http://localhost/reset-password" });
    const resetUnknown = await post("/api/auth/request-password-reset", { email: newEmail(), redirectTo: "http://localhost/reset-password" });
    expect(resetKnown.status).toBe(200);
    expect(await resetKnown.text()).toBe(await resetUnknown.text());
    const resetLimited = await post("/api/auth/request-password-reset", { email: known, redirectTo: "http://localhost/reset-password" });
    expect(resetLimited.status).toBe(429);
    expect(await resetLimited.json()).toMatchObject({ code: "PASSWORD_RESET_LIMITED" });
  });
});

test("signing up with a taken email gets the same generic refusal as any other sign-up failure", async () => {
  await withRollback(db, async (transaction) => {
    const { signUp } = harness(transaction);
    const email = newEmail();
    expect((await signUp(email)).status).toBe(200);
    const taken = await signUp(email);
    const body = await taken.text();
    expect(taken.status).not.toBe(200);
    expect(JSON.parse(body)).toEqual({ code: "SIGN_UP_FAILED", message: "Could not create the account." });
    expect(body).not.toContain("USER_ALREADY_EXISTS");
  });
});

test("an API token over the per-minute limit gets 429 with Retry-After and RateLimit headers, and the window resets", async () => {
  await withRollback(db, async (transaction) => {
    const { clock, post, signUp } = harness(transaction, { apiRequestsPerMinute: 3 });
    const cookie = { cookie: (await signUp(newEmail())).headers.get("set-cookie")!.split(";")[0]! };
    const workspace = await (await post("/actions/create_workspace", { name: "Team", slug: `t-${crypto.randomUUID()}` }, cookie)).json() as { id: string };
    const created = await (await post("/actions/create_api_token", { name: "cli" }, cookie)).json() as { token: string };
    const bearer = { authorization: `Bearer ${created.token}` };
    const list = () => post("/actions/list_projects", { workspaceId: workspace.id }, bearer);

    const remaining: string[] = [];
    for (let call = 0; call < 3; call++) {
      const ok = await list();
      expect(ok.status).toBe(200);
      expect(ok.headers.get("ratelimit-limit")).toBe("3");
      remaining.push(ok.headers.get("ratelimit-remaining")!);
    }
    expect(remaining).toEqual(["2", "1", "0"]);
    const over = await list();
    expect(over.status).toBe(429);
    expect(await over.json()).toMatchObject({ code: "rate_limited" });
    expect(Number(over.headers.get("retry-after"))).toBeGreaterThan(0);
    clock.at += 61_000;
    expect((await list()).status).toBe(200);

    for (let call = 0; call < 5; call++) {
      expect((await post("/actions/list_projects", { workspaceId: workspace.id }, cookie)).status).toBe(200);
    }
  });
});

test("normal CLI use stays under the default limit, and Daemon endpoints are never answered 429", async () => {
  await withRollback(db, async (transaction) => {
    const { app, post, signUp } = harness(transaction);
    const cookie = { cookie: (await signUp(newEmail())).headers.get("set-cookie")!.split(";")[0]! };
    const me = await (await app.handle(new Request("http://localhost/api/me", { headers: cookie }))).json() as { user: { id: string } };
    const workspace = await (await post("/actions/create_workspace", { name: "Team", slug: `t-${crypto.randomUUID()}` }, cookie)).json() as { id: string };
    const created = await (await post("/actions/create_api_token", { name: "cli" }, cookie)).json() as { token: string };
    const bearer = { authorization: `Bearer ${created.token}` };
    for (let call = 0; call < 60; call++) {
      expect((await post("/actions/list_projects", { workspaceId: workspace.id }, bearer)).status).toBe(200);
    }

    const tightDaemon = harness(transaction, { apiRequestsPerMinute: 1 });
    const daemon = await mintApiToken(transaction, { userId: me.user.id, name: "Daemon @ test", description: "Restricted Daemon credential", expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), daemonOnly: true });
    for (let call = 0; call < 5; call++) {
      const response = await tightDaemon.post("/api/daemon/stop", {}, { authorization: `Bearer ${daemon.token}` });
      expect(response.status).not.toBe(429);
    }
  });
});

test("limits are read from the environment; an invalid value keeps its default and logs a warning", () => {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (message: unknown) => { warnings.push(String(message)); };
  try {
    const settings = rateLimitSettings({ SIGN_IN_MAX_FAILURES: "7", API_REQUESTS_PER_MINUTE: "lots", SIGN_IN_LOCK_MINUTES: "0" });
    expect(settings.signInMaxFailures).toBe(7);
    expect(settings.apiRequestsPerMinute).toBe(600);
    expect(settings.signInLockMinutes).toBe(15);
    expect(warnings).toHaveLength(2);
  } finally {
    console.warn = originalWarn;
  }
});

test("every rate-limit setting is documented in the README environment table and in .env.example", () => {
  const readme = readFileSync(new URL("../../../README.md", import.meta.url), "utf8");
  const example = readFileSync(new URL("../../../.env.example", import.meta.url), "utf8");
  for (const variable of RATE_LIMIT_VARIABLES) {
    expect(readme).toContain(`\`${variable}\``);
    expect(example).toMatch(new RegExp(`^${variable}=`, "m"));
  }
});

/** A Runtime Run with its own Run token: one Agent assigned on a shared Runtime, claimed by the Daemon. */
async function startRun(transaction: Transaction, settings: Partial<RateLimitSettings> = {}) {
  const h = harness(transaction, settings);
  const cookie = { cookie: (await h.signUp(newEmail())).headers.get("set-cookie")!.split(";")[0]! };
  const owner = await (await h.app.handle(new Request("http://localhost/api/me", { headers: cookie }))).json() as { user: { id: string } };
  const workspace = await (await h.post("/actions/create_workspace", { name: "Team", slug: `run-${crypto.randomUUID()}` }, cookie)).json() as { id: string };
  const daemon = await (await h.post("/actions/create_api_token", { name: "daemon" }, cookie)).json() as { token: string };
  await h.post("/actions/set_autopilot_setting", { workspaceId: workspace.id, allowAutopilot: true }, cookie);
  const daemonBearer = { authorization: `Bearer ${daemon.token}` };
  const project = await createProjectActions(transaction).createProject.handler({ userId: owner.user.id }, { workspaceId: workspace.id, name: "Run", key: `RL${crypto.randomUUID().slice(0, 4).toUpperCase()}`, visibility: "private" });
  const agents = createAgentActions(transaction);
  const agent = await agents.createAgent.handler({ userId: owner.user.id }, { workspaceId: workspace.id, name: "Runtime Agent", instructions: "Work", model: "default" });
  await agents.setAgentProjectAccess.handler({ userId: owner.user.id }, { agentId: agent.id, allProjects: true, projectIds: [] });
  const registration = await (await h.post("/actions/register_daemon", { hostname: "limits", version: "1", agentClis: ["claude"] }, daemonBearer)).json() as { runtimes: Array<{ id: string }>; daemonToken: string };
  const daemonCredential = { authorization: `Bearer ${registration.daemonToken}` };
  await createRuntimeActions(transaction).shareRuntime.handler({ userId: owner.user.id }, { runtimeId: registration.runtimes[0]!.id });
  await agents.updateAgent.handler({ userId: owner.user.id }, { agentId: agent.id, runtimeId: registration.runtimes[0]!.id });
  const item = await createWorkItemActions(transaction).createWorkItem.handler({ userId: owner.user.id }, { projectId: project.id, title: "Limited run", assigneeIds: [agent.userId] });
  const [claimed] = await (await h.post("/api/daemon/runs/claim", {}, daemonCredential)).json() as Array<{ token: string }>;
  expect(claimed?.token).toStartWith("weft_run_");
  const runBearer = { authorization: `Bearer ${claimed!.token}` };
  const read = () => h.post("/actions/get_work_item", { workspaceId: workspace.id, displayId: item.displayId }, runBearer);
  return { h, read };
}

test("a Runtime Run making three minutes' worth of normal calls at the default limit is never throttled", async () => {
  expect(DEFAULT_RATE_LIMITS.apiRequestsPerMinute).toBe(600);
  await withRollback(db, async (transaction) => {
    const { h, read } = await startRun(transaction);
    // 3 x 600 calls, one every 150 ms of the test clock (400 per minute, under the limit): three full windows, none refused.
    const calls = 3 * DEFAULT_RATE_LIMITS.apiRequestsPerMinute;
    const refused: number[] = [];
    for (let call = 0; call < calls; call++) {
      h.clock.at += 150;
      const response = await read();
      if (response.status !== 200) refused.push(response.status);
    }
    expect(refused).toEqual([]);
  });
}, 300_000);

test("a Run over the limit gets a prompt 429 with a readable error and Retry-After, not a hang", async () => {
  await withRollback(db, async (transaction) => {
    const { read } = await startRun(transaction, { apiRequestsPerMinute: 3 });
    for (let call = 0; call < 3; call++) expect((await read()).status).toBe(200);
    const started = performance.now();
    const refused = await read();
    const elapsed = performance.now() - started;
    expect(refused.status).toBe(429);
    expect(elapsed).toBeLessThan(2_000);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    const body = await refused.json() as { code: string; error: string; retryAfterSeconds: number };
    expect(body.code).toBe("rate_limited");
    expect(body.error).toContain("Too many requests: 3 per minute");
    expect(body.retryAfterSeconds).toBeGreaterThan(0);
  });
}, 60_000);
