import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { apiTokens, cliDeviceAuthorizations, cliDevices, daemons, projects, runs, runtimes, workspaceMembers } from "@weft/db";
import { eq, inArray } from "drizzle-orm";
import { createUserFactory, createWorkspaceFactory, withRollback } from "../../../packages/db/src/test-helpers";
import { createApp } from "../src/app";
import { login, renewCliCredential } from "../../cli/src/daemon";
import { main } from "../../cli/src/program";
import { createApiTokenActions, createJobHandlers, createProjectActions, mintApiToken, sweepRuntimeRuns } from "@weft/actions";

const { client, db } = (await import("@weft/db")).createDatabase();
afterAll(async () => client.end());

test.concurrent("device sign-in requires the browser owner to approve, exchanges once, and replaces only that device after finalize", async () => {
  await withRollback(db, async (transaction) => {
    const app = createApp(undefined, transaction);
    const call = (path: string, method: string, body?: unknown, headers: Record<string, string> = {}) => app.handle(new Request(`http://localhost${path}`, {
      method, headers: { ...(path.endsWith("/decision") ? { origin: "http://localhost:5173" } : {}), ...(body ? { "content-type": "application/json" } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}),
    }));
    const signup = async (name: string) => {
      const response = await call("/api/auth/sign-up/email", "POST", { name, email: `${crypto.randomUUID()}@example.test`, password: "a-secure-password" });
      return response.headers.get("set-cookie")!.split(";")[0]!;
    };
    const cookie = await signup("Owner");
    const strangerCookie = await signup("Stranger");
    const start = await call("/api/cli/device-authorization", "POST", { hostname: "same-host", deviceId: crypto.randomUUID() });
    expect(start.status).toBe(201);
    const request = await start.json() as { userCode: string; deviceSecret: string };
    expect((await call("/api/cli/device-authorization", "GET", undefined, { cookie })).status).toBe(404);
    const details = await call(`/api/cli/device-authorization?code=${encodeURIComponent(request.userCode)}`, "GET", undefined, { cookie });
    expect(await details.json()).toMatchObject({ hostname: "same-host", access: "account-wide" });
    expect((await call("/api/cli/device-authorization/decision", "POST", { code: request.userCode, decision: "approve" }, { cookie: strangerCookie, origin: "https://attacker.example" })).status).toBe(403);
    expect((await call("/api/cli/device-authorization/decision", "POST", { code: request.userCode, decision: "approve" }, { cookie: strangerCookie })).status).toBe(200);
    expect((await call("/api/cli/device-authorization/decision", "POST", { code: request.userCode, decision: "approve" }, { cookie })).status).toBe(404);
    expect((await call("/api/cli/device-authorization/poll", "POST", { deviceSecret: request.deviceSecret })).status).toBe(200);
    const exchange = await call("/api/cli/device-authorization/exchange", "POST", { deviceSecret: request.deviceSecret });
    expect(exchange.status).toBe(200);
    const first = await exchange.json() as { token: string; exchangeId: string };
    expect(first.token).toMatch(/^weft_/);
    expect((await call("/api/cli/device-authorization/exchange", "POST", { deviceSecret: request.deviceSecret })).status).toBe(409);
    const unrelated = await (await call("/actions/create_api_token", "POST", { name: "Unrelated" }, { cookie })).json() as { token: string };
    expect((await call("/api/cli/device-authorization/finalize", "POST", { exchangeId: first.exchangeId }, { authorization: `Bearer ${unrelated.token}` })).status).toBe(409);
    expect((await call("/api/cli/device-authorization/finalize", "POST", { exchangeId: first.exchangeId }, { authorization: `Bearer ${first.token}` })).status).toBe(200);
    const strangerId = (await (await call("/api/auth/get-session", "GET", undefined, { cookie: strangerCookie })).json() as { user: { id: string } }).user.id;
    expect(await transaction.select().from(apiTokens).where(eq(apiTokens.userId, strangerId))).toHaveLength(1);
  });
});

test.concurrent("device revocation fences exchanged and in-flight credentials, including a replayed finalize", async () => {
  await withRollback(db, async (transaction) => {
    const app = createApp(undefined, transaction);
    const call = (path: string, method: string, body?: unknown, headers: Record<string, string> = {}) => app.handle(new Request(`http://localhost${path}`, {
      method, headers: { ...(path.endsWith("/decision") ? { origin: "http://localhost:5173" } : {}), ...(body ? { "content-type": "application/json" } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}),
    }));
    const signedIn = await call("/api/auth/sign-up/email", "POST", { name: "Owner", email: `${crypto.randomUUID()}@example.test`, password: "a-secure-password" });
    const cookie = signedIn.headers.get("set-cookie")!.split(";")[0]!;
    const userId = ((await (await call("/api/auth/get-session", "GET", undefined, { cookie })).json()) as { user: { id: string } }).user.id;
    const workspace = await (await call("/actions/create_workspace", "POST", { name: "Device security", slug: `ds-${crypto.randomUUID()}` }, { cookie })).json() as { id: string };
    const deviceId = crypto.randomUUID();
    const enroll = async (afterRevocation = false) => {
      const started = await call("/api/cli/device-authorization", "POST", { deviceId, hostname: "revoked-host" });
      const request = await started.json() as { userCode: string; deviceSecret: string };
      await call("/api/cli/device-authorization/decision", "POST", { code: request.userCode, decision: "approve" }, { cookie });
      if (afterRevocation) {
        const [device] = await transaction.select({ revokedAt: cliDevices.revokedAt }).from(cliDevices).where(eq(cliDevices.deviceId, deviceId));
        const [authorization] = await transaction.select({ id: cliDeviceAuthorizations.id }).from(cliDeviceAuthorizations)
          .where(eq(cliDeviceAuthorizations.userCodeHash, createHash("sha256").update(request.userCode).digest("hex")));
        await transaction.update(cliDeviceAuthorizations).set({ createdAt: new Date(device!.revokedAt!.getTime() + 10) }).where(eq(cliDeviceAuthorizations.id, authorization!.id));
      }
      return { request, exchange: await (await call("/api/cli/device-authorization/exchange", "POST", { deviceSecret: request.deviceSecret })).json() as { token: string; exchangeId: string } };
    };
    const first = await enroll();
    expect((await call("/api/cli/device-authorization/finalize", "POST", { exchangeId: first.exchange.exchangeId }, { authorization: `Bearer ${first.exchange.token}` })).status).toBe(200);
    const pending = await enroll();
    const pendingAction = await call("/actions/list_projects", "POST", { workspaceId: workspace.id }, { authorization: `Bearer ${pending.exchange.token}` });
    expect(pendingAction.status).toBe(401);

    await createApiTokenActions(transaction).revokeCliDevice.handler({ userId }, { deviceId });
    expect([401, 409]).toContain((await call("/api/cli/device-authorization/finalize", "POST", { exchangeId: pending.exchange.exchangeId }, { authorization: `Bearer ${pending.exchange.token}` })).status);
    expect((await call("/actions/list_projects", "POST", { workspaceId: workspace.id }, { authorization: `Bearer ${first.exchange.token}` })).status).toBe(401);
    expect((await call("/actions/list_projects", "POST", { workspaceId: workspace.id }, { authorization: `Bearer ${pending.exchange.token}` })).status).toBe(401);
    expect((await transaction.select({ status: cliDeviceAuthorizations.status }).from(cliDeviceAuthorizations).where(eq(cliDeviceAuthorizations.id, pending.exchange.exchangeId)))[0]?.status).toBe("revoked");
    expect((await transaction.select({ revokedAt: cliDevices.revokedAt }).from(cliDevices).where(eq(cliDevices.deviceId, deviceId)))[0]?.revokedAt).toBeInstanceOf(Date);

    const reauthorized = await enroll(true);
    expect((await call("/api/cli/device-authorization/finalize", "POST", { exchangeId: reauthorized.exchange.exchangeId }, { authorization: `Bearer ${reauthorized.exchange.token}` })).status).toBe(200);
    expect((await call("/actions/list_projects", "POST", { workspaceId: workspace.id }, { authorization: `Bearer ${reauthorized.exchange.token}` })).status).toBe(200);
  });
});

test.concurrent("a concurrent finalize and revoke leave the device revoked", async () => {
  const owner = await createUserFactory(db);
  const deviceId = crypto.randomUUID();
  const prior = await mintApiToken(db, { userId: owner.id, name: "CLI @ race-host", description: null, cliDeviceId: deviceId });
  const replacement = await mintApiToken(db, { userId: owner.id, name: "CLI @ race-host", description: null, cliDeviceId: deviceId });
  await db.insert(cliDevices).values({ ownerId: owner.id, deviceId, hostname: "race-host", tokenId: prior.id });
  const exchangeId = crypto.randomUUID();
  await db.insert(cliDeviceAuthorizations).values({
    id: exchangeId, deviceId, hostname: "race-host", userId: owner.id, tokenId: replacement.id, previousTokenId: prior.id,
    deviceSecretHash: crypto.randomUUID().replaceAll("-", ""), userCodeHash: crypto.randomUUID().replaceAll("-", ""),
    status: "rotating", expiresAt: new Date(Date.now() + 10 * 60_000),
  });
  const app = createApp(undefined, db);
  const finalize = app.handle(new Request("http://localhost/api/cli/device-authorization/finalize", {
    method: "POST", headers: { authorization: `Bearer ${replacement.token}`, "content-type": "application/json" }, body: JSON.stringify({ exchangeId }),
  }));
  const revoke = createApiTokenActions(db).revokeCliDevice.handler({ userId: owner.id }, { deviceId });
  const [finalizeResponse] = await Promise.all([finalize, revoke]);
  expect([200, 401, 409]).toContain(finalizeResponse.status);
  expect((await app.handle(new Request("http://localhost/api/cli/device-credentials/renew", { method: "POST", headers: { authorization: `Bearer ${replacement.token}` } }))).status).toBe(401);
  const [device] = await db.select({ tokenId: cliDevices.tokenId, revokedAt: cliDevices.revokedAt }).from(cliDevices).where(eq(cliDevices.deviceId, deviceId));
  expect(device?.revokedAt).toBeInstanceOf(Date);
  expect([prior.id, replacement.id]).toContain(device?.tokenId);
  const credentials = await db.select({ revokedAt: apiTokens.revokedAt }).from(apiTokens).where(inArray(apiTokens.id, [prior.id, replacement.id]));
  expect(credentials).toHaveLength(2);
  expect(credentials.every(({ revokedAt }) => revokedAt instanceof Date)).toBe(true);
});

test.concurrent("a denied request keeps the existing credential valid and cannot be completed later", async () => {
  await withRollback(db, async (transaction) => {
    const app = createApp(undefined, transaction);
    const call = (path: string, method: string, body?: unknown, headers: Record<string, string> = {}) => app.handle(new Request(`http://localhost${path}`, {
      method, headers: { ...(path.endsWith("/decision") ? { origin: "http://localhost:5173" } : {}), ...(body ? { "content-type": "application/json" } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}),
    }));
    const old = await (await call("/api/auth/sign-up/email", "POST", { name: "Owner", email: `${crypto.randomUUID()}@example.test`, password: "a-secure-password" })).headers.get("set-cookie")!.split(";")[0]!;
    const prior = await (await call("/actions/create_api_token", "POST", { name: "prior" }, { cookie: old })).json() as { token: string };
    const start = await call("/api/cli/device-authorization", "POST", { hostname: "same-host", deviceId: crypto.randomUUID() });
    const request = await start.json() as { userCode: string; deviceSecret: string };
    const denial = await call("/api/cli/device-authorization/decision", "POST", { code: request.userCode, decision: "deny" }, { cookie: old });
    expect(denial.status).toBe(200);
    expect(await (await call("/api/cli/device-authorization/poll", "POST", { deviceSecret: request.deviceSecret })).json()).toMatchObject({ status: "denied" });
    const workspace = await (await call("/actions/create_workspace", "POST", { name: "Team", slug: `t-${crypto.randomUUID()}` }, { cookie: old })).json() as { id: string };
    expect((await call("/actions/list_projects", "POST", { workspaceId: workspace.id }, { authorization: `Bearer ${prior.token}` })).status).toBe(200);
    expect((await call("/api/cli/device-authorization/exchange", "POST", { deviceSecret: request.deviceSecret })).status).toBe(409);
  });
});

test.concurrent("the CLI drops an expired pending exchange and keeps its previously finalized credential", async () => {
  const configHome = await mkdtemp(join(tmpdir(), "weft-expired-pending-"));
  const directory = join(configHome, "weft");
  const previous = "weft_previous_credential";
  const deviceId = crypto.randomUUID();
  try {
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(join(directory, "config.json"), JSON.stringify({
      token: previous, apiUrl: "https://weft.example", deviceId,
      pendingCredential: { token: "weft_expired_candidate", exchangeId: crypto.randomUUID(), apiUrl: "https://weft.example", deviceId },
    }), { mode: 0o600 });
    const fetcher = async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      if (url.pathname.endsWith("/finalize")) return new Response(JSON.stringify({ error: "expired" }), { status: 410 });
      return new Response(JSON.stringify({ status: "current" }), { status: 200 });
    };
    expect(await renewCliCredential({ env: { XDG_CONFIG_HOME: configHome }, fetch: fetcher }, "https://weft.example")).toBe(previous);
    const saved = JSON.parse(await readFile(join(directory, "config.json"), "utf8")) as { token: string; pendingCredential?: unknown };
    expect(saved.token).toBe(previous);
    expect(saved.pendingCredential).toBeUndefined();
  } finally { await rm(configHome, { recursive: true, force: true }); }
});

test.concurrent("two devices with the same hostname stay separate when one device signs in again", async () => {
  await withRollback(db, async (transaction) => {
    const app = createApp(undefined, transaction);
    const call = (path: string, method: string, body?: unknown, headers: Record<string, string> = {}) => app.handle(new Request(`http://localhost${path}`, {
      method, headers: { ...(path.endsWith("/decision") ? { origin: "http://localhost:5173" } : {}), ...(body ? { "content-type": "application/json" } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}),
    }));
    const signedIn = await call("/api/auth/sign-up/email", "POST", { name: "Owner", email: `${crypto.randomUUID()}@example.test`, password: "a-secure-password" });
    const cookie = signedIn.headers.get("set-cookie")!.split(";")[0]!;
    const deviceIds = [crypto.randomUUID(), crypto.randomUUID()];
    const enroll = async (deviceId: string) => {
      const started = await call("/api/cli/device-authorization", "POST", { deviceId, hostname: "shared-host" });
      const request = await started.json() as { userCode: string; deviceSecret: string };
      expect((await call("/api/cli/device-authorization/decision", "POST", { code: request.userCode, decision: "approve" }, { cookie })).status).toBe(200);
      const issued = await (await call("/api/cli/device-authorization/exchange", "POST", { deviceSecret: request.deviceSecret })).json() as { token: string; exchangeId: string };
      expect((await call("/api/cli/device-authorization/finalize", "POST", { exchangeId: issued.exchangeId }, { authorization: `Bearer ${issued.token}` })).status).toBe(200);
      return issued.token;
    };
    const first = await enroll(deviceIds[0]!);
    const second = await enroll(deviceIds[1]!);
    const ownerId = (await (await call("/api/auth/get-session", "GET", undefined, { cookie })).json() as { user: { id: string } }).user.id;
    const [firstDevice, secondDevice] = await transaction.select().from(apiTokens).where(eq(apiTokens.userId, ownerId));
    expect(firstDevice?.revokedAt).toBeNull();
    expect(secondDevice?.revokedAt).toBeNull();
    const replacedFirst = await enroll(deviceIds[0]!);
    expect(replacedFirst).not.toBe(first);
    const tokens = await transaction.select().from(apiTokens).where(eq(apiTokens.userId, ownerId));
    expect(tokens.filter((token) => token.revokedAt === null)).toHaveLength(2);
    expect(tokens.find((token) => token.tokenHash === createHash("sha256").update(first).digest("hex"))?.revokedAt).not.toBeNull();
    expect(tokens.find((token) => token.tokenHash === createHash("sha256").update(second).digest("hex"))?.revokedAt).toBeNull();
  });
});

test.concurrent("weft login prints the manual path, completes browser approval, and stores credentials with private permissions", async () => {
  await withRollback(db, async (transaction) => {
    const app = createApp(undefined, transaction);
    const signedIn = await app.handle(new Request("http://localhost/api/auth/sign-up/email", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Owner", email: `${crypto.randomUUID()}@example.test`, password: "a-secure-password" }) }));
    const cookie = signedIn.headers.get("set-cookie")!.split(";")[0]!;
    const configHome = await mkdtemp(join(tmpdir(), "weft-device-login-"));
    try {
      const output: string[] = [];
      const apiFetch = async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
        return app.handle(new Request(`http://localhost${url.pathname}${url.search}`, init));
      };
      await login({
        env: { WEFT_API_URL: "https://weft.example", WEFT_HOSTNAME: "shared-host", XDG_CONFIG_HOME: configHome },
        fetch: apiFetch, stdout: (line) => output.push(line), sleep: async () => {},
        openBrowser: async (url) => {
          const code = new URL(url).searchParams.get("code")!;
          const details = await app.handle(new Request(`http://localhost/api/cli/device-authorization?code=${code}`, { headers: { cookie } }));
          expect(details.status).toBe(200);
          const approved = await app.handle(new Request("http://localhost/api/cli/device-authorization/decision", { method: "POST", headers: { cookie, origin: "http://localhost:5173", "content-type": "application/json" }, body: JSON.stringify({ code, decision: "approve" }) }));
          expect(approved.status).toBe(200);
          throw new Error("No browser launcher");
        },
      });
      expect(output.join("")).toContain("Enter code:");
      expect(output.join("")).toContain("Could not open a browser here");
      expect(output.join("")).toContain("Token saved");
      expect(output.join("")).not.toContain("weft_");
      const configPath = join(configHome, "weft", "config.json");
      const config = JSON.parse(await readFile(configPath, "utf8")) as { token: string; apiUrl: string; deviceId: string };
      expect(config).toMatchObject({ apiUrl: "https://weft.example" });
      expect(config.token).toMatch(/^weft_/);
      expect(config.deviceId).toMatch(/^[0-9a-f-]{36}$/i);
      expect((await stat(configPath)).mode & 0o777).toBe(0o600);
      expect((await stat(join(configHome, "weft"))).mode & 0o777).toBe(0o700);
    } finally { await rm(configHome, { recursive: true, force: true }); }
  });
});

test.concurrent("a failed finalize preserves the installed credential and login reports failure", async () => {
  await withRollback(db, async (transaction) => {
    const app = createApp(undefined, transaction);
    const signup = await app.handle(new Request("http://localhost/api/auth/sign-up/email", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Owner", email: `${crypto.randomUUID()}@example.test`, password: "a-secure-password" }) }));
    const cookie = signup.headers.get("set-cookie")!.split(";")[0]!;
    const configHome = await mkdtemp(join(tmpdir(), "weft-login-recovery-"));
    const apiFetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      return app.handle(new Request(`http://localhost${url.pathname}${url.search}`, init));
    };
    const options = (fetcher = apiFetch) => ({
      env: { WEFT_API_URL: "https://weft.example", XDG_CONFIG_HOME: configHome }, fetch: fetcher, stdout: () => {}, sleep: async () => {},
      openBrowser: async (url: string) => {
        const code = new URL(url).searchParams.get("code")!;
        await app.handle(new Request(`http://localhost/api/cli/device-authorization/decision`, { method: "POST", headers: { cookie, origin: "http://localhost:5173", "content-type": "application/json" }, body: JSON.stringify({ code, decision: "approve" }) }));
      },
    });
    try {
      await login(options());
      const configPath = join(configHome, "weft", "config.json");
      const original = (JSON.parse(await readFile(configPath, "utf8")) as { token: string }).token;
      let finalizeFailure = true;
      const failBeforeCommit: typeof apiFetch = async (input, init) => {
        const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
        if (url.pathname.endsWith("/finalize") && finalizeFailure) { finalizeFailure = false; return new Response("unavailable", { status: 503 }); }
        return apiFetch(input, init);
      };
      await expect(login(options(failBeforeCommit))).rejects.toThrow("server did not confirm");
      const waiting = JSON.parse(await readFile(configPath, "utf8")) as { token: string; pendingCredential?: { token: string } };
      expect(waiting.token).toBe(original);
      expect(waiting.pendingCredential?.token).toMatch(/^weft_/);
      expect((await apiFetch("http://localhost/api/cli/device-credentials/renew", { method: "POST", headers: { authorization: `Bearer ${original}` } })).status).toBe(200);
      const recovered = await renewCliCredential({ env: { XDG_CONFIG_HOME: configHome }, fetch: apiFetch }, "https://weft.example");
      expect(recovered).toBe(waiting.pendingCredential?.token);
      expect((JSON.parse(await readFile(configPath, "utf8")) as { token: string; pendingCredential?: unknown }).pendingCredential).toBeUndefined();
    } finally { await rm(configHome, { recursive: true, force: true }); }
  });
});

test.concurrent("a finalize response lost after server commit is recovered from disk on the next invocation", async () => {
  await withRollback(db, async (transaction) => {
    const app = createApp(undefined, transaction);
    const signup = await app.handle(new Request("http://localhost/api/auth/sign-up/email", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Owner", email: `${crypto.randomUUID()}@example.test`, password: "a-secure-password" }) }));
    const cookie = signup.headers.get("set-cookie")!.split(";")[0]!;
    const configHome = await mkdtemp(join(tmpdir(), "weft-lost-finalize-"));
    const apiFetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      return app.handle(new Request(`http://localhost${url.pathname}${url.search}`, init));
    };
    const options = (fetcher: typeof apiFetch) => ({ env: { WEFT_API_URL: "https://weft.example", XDG_CONFIG_HOME: configHome }, fetch: fetcher, stdout: () => {}, sleep: async () => {}, openBrowser: async (url: string) => {
      const code = new URL(url).searchParams.get("code")!;
      await app.handle(new Request("http://localhost/api/cli/device-authorization/decision", { method: "POST", headers: { cookie, origin: "http://localhost:5173", "content-type": "application/json" }, body: JSON.stringify({ code, decision: "approve" }) }));
    } });
    try {
      await login(options(apiFetch));
      const configPath = join(configHome, "weft", "config.json");
      const original = (JSON.parse(await readFile(configPath, "utf8")) as { token: string }).token;
      let lost = false;
      const lostResponse: typeof apiFetch = async (input, init) => {
        const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
        const response = await apiFetch(input, init);
        if (url.pathname.endsWith("/finalize") && !lost) { lost = true; return new Response("response lost", { status: 503 }); }
        return response;
      };
      await expect(login(options(lostResponse))).rejects.toThrow("server did not confirm");
      const waiting = JSON.parse(await readFile(configPath, "utf8")) as { token: string; pendingCredential: { token: string; exchangeId: string } };
      expect(waiting.token).toBe(original);
      expect(waiting.pendingCredential.token).toMatch(/^weft_/);
      const recovered = await renewCliCredential({ env: { XDG_CONFIG_HOME: configHome }, fetch: apiFetch }, "https://weft.example");
      expect(recovered).toBe(waiting.pendingCredential.token);
      expect((JSON.parse(await readFile(configPath, "utf8")) as { token: string }).token).toBe(recovered!);
    } finally { await rm(configHome, { recursive: true, force: true }); }
  });
});

test.concurrent("reversed concurrent login completions serialize finalize and match the on-disk generation", async () => {
  await withRollback(db, async (transaction) => {
    const app = createApp(undefined, transaction);
    const signup = await app.handle(new Request("http://localhost/api/auth/sign-up/email", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Owner", email: `${crypto.randomUUID()}@example.test`, password: "a-secure-password" }) }));
    const cookie = signup.headers.get("set-cookie")!.split(";")[0]!;
    const configHome = await mkdtemp(join(tmpdir(), "weft-login-race-"));
    let exchanges = 0;
    const startedDeviceIds: string[] = [];
    let unblockFirst!: () => void;
    let firstExchange!: () => void;
    const firstAtExchange = new Promise<void>((resolve) => { firstExchange = resolve; });
    const letFirstProceed = new Promise<void>((resolve) => { unblockFirst = resolve; });
    const apiFetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      if (url.pathname.endsWith("/device-authorization") && init?.method === "POST") {
        startedDeviceIds.push((JSON.parse(String(init.body)) as { deviceId: string }).deviceId);
      }
      const response = await app.handle(new Request(`http://localhost${url.pathname}${url.search}`, init));
      if (url.pathname.endsWith("/exchange")) {
        exchanges += 1;
        if (exchanges === 1) { firstExchange(); await letFirstProceed; }
      }
      return response;
    };
    const makeOptions = () => ({ env: { WEFT_API_URL: "https://weft.example", XDG_CONFIG_HOME: configHome }, fetch: apiFetch, stdout: () => {}, sleep: async () => {}, openBrowser: async (verificationUrl: string) => {
      const code = new URL(verificationUrl).searchParams.get("code")!;
      await app.handle(new Request("http://localhost/api/cli/device-authorization/decision", { method: "POST", headers: { cookie, origin: "http://localhost:5173", "content-type": "application/json" }, body: JSON.stringify({ code, decision: "approve" }) }));
    } });
    try {
      const firstLogin = login(makeOptions());
      await firstAtExchange;
      await login(makeOptions());
      const secondGeneration = (JSON.parse(await readFile(join(configHome, "weft", "config.json"), "utf8")) as { token: string }).token;
      unblockFirst();
      await firstLogin;
      const finalConfig = JSON.parse(await readFile(join(configHome, "weft", "config.json"), "utf8")) as { token: string; pendingCredential?: unknown };
      expect(startedDeviceIds).toHaveLength(2);
      expect(new Set(startedDeviceIds).size).toBe(1);
      expect(finalConfig.token).not.toBe(secondGeneration);
      expect(finalConfig.pendingCredential).toBeUndefined();
      const finalCheck = await apiFetch("http://localhost/api/cli/device-credentials/renew", { method: "POST", headers: { authorization: `Bearer ${finalConfig.token}` } });
      expect(finalCheck.status).toBe(200);
      const [staleRow] = await transaction.select({ revokedAt: apiTokens.revokedAt }).from(apiTokens).where(eq(apiTokens.tokenHash, createHash("sha256").update(secondGeneration).digest("hex")));
      expect(staleRow?.revokedAt).toBeInstanceOf(Date);
    } finally { unblockFirst(); await rm(configHome, { recursive: true, force: true }); }
  });
});

test.concurrent("login and renewal on one config serialize and finish on the last installed credential", async () => {
  await withRollback(db, async (transaction) => {
    const app = createApp(undefined, transaction);
    const signup = await app.handle(new Request("http://localhost/api/auth/sign-up/email", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Owner", email: `${crypto.randomUUID()}@example.test`, password: "a-secure-password" }) }));
    const cookie = signup.headers.get("set-cookie")!.split(";")[0]!;
    const configHome = await mkdtemp(join(tmpdir(), "weft-login-renew-race-"));
    const env = { WEFT_API_URL: "https://weft.example", XDG_CONFIG_HOME: configHome };
    const apiFetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      return app.handle(new Request(`http://localhost${url.pathname}${url.search}`, init));
    };
    const loginOptions = (fetcher = apiFetch) => ({ env, fetch: fetcher, stdout: () => {}, sleep: async () => {}, openBrowser: async (verificationUrl: string) => {
      const code = new URL(verificationUrl).searchParams.get("code")!;
      await app.handle(new Request("http://localhost/api/cli/device-authorization/decision", { method: "POST", headers: { cookie, origin: "http://localhost:5173", "content-type": "application/json" }, body: JSON.stringify({ code, decision: "approve" }) }));
    } });
    try {
      await login(loginOptions());
      const configPath = join(configHome, "weft", "config.json");
      const original = (JSON.parse(await readFile(configPath, "utf8")) as { token: string }).token;
      await transaction.update(apiTokens).set({ createdAt: new Date(Date.now() - 31 * 24 * 60 * 60_000), expiresAt: new Date(Date.now() + 60 * 24 * 60 * 60_000) })
        .where(eq(apiTokens.tokenHash, createHash("sha256").update(original).digest("hex")));
      let reachedFinalize!: () => void;
      let releaseFinalize!: () => void;
      const finalizeReached = new Promise<void>((resolve) => { reachedFinalize = resolve; });
      const finalizeGate = new Promise<void>((resolve) => { releaseFinalize = resolve; });
      const blockedFinalize: typeof apiFetch = async (input, init) => {
        const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
        const response = await apiFetch(input, init);
        if (url.pathname.endsWith("/finalize")) { reachedFinalize(); await finalizeGate; }
        return response;
      };
      const renewal = renewCliCredential({ env, fetch: blockedFinalize }, "https://weft.example");
      await finalizeReached;
      const relogin = login(loginOptions());
      await Bun.sleep(25); // Give login time to queue on the renewal's held SQLite lock.
      releaseFinalize();
      const renewed = await renewal;
      await relogin;
      const finalConfig = JSON.parse(await readFile(configPath, "utf8")) as { token: string; pendingCredential?: unknown };
      expect(renewed).not.toBe(original);
      expect(finalConfig.token).not.toBe(renewed);
      expect(finalConfig.pendingCredential).toBeUndefined();
      const rows = await transaction.select({ tokenHash: apiTokens.tokenHash, revokedAt: apiTokens.revokedAt }).from(apiTokens)
        .where(inArray(apiTokens.tokenHash, [createHash("sha256").update(original).digest("hex"), createHash("sha256").update(renewed!).digest("hex")]));
      expect(rows.find((row) => row.tokenHash === createHash("sha256").update(original).digest("hex"))?.revokedAt).toBeInstanceOf(Date);
      expect(rows.find((row) => row.tokenHash === createHash("sha256").update(renewed!).digest("hex"))?.revokedAt).toBeInstanceOf(Date);
      const finalResponse = await apiFetch("http://localhost/api/cli/device-credentials/renew", { method: "POST", headers: { authorization: `Bearer ${finalConfig.token}` } });
      expect(finalResponse.status).toBe(200);
    } finally { await rm(configHome, { recursive: true, force: true }); }
  });
});

test.concurrent("remote HTTP is rejected before login or renewal sends a secret", async () => {
  const configHome = await mkdtemp(join(tmpdir(), "weft-http-auth-"));
  let calls = 0;
  const fetcher = async () => { calls += 1; return new Response(null, { status: 200 }); };
  try {
    await expect(login({ env: { WEFT_API_URL: "http://weft.example", XDG_CONFIG_HOME: configHome }, fetch: fetcher })).rejects.toThrow("require HTTPS");
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(join(configHome, "weft"), { recursive: true });
    await writeFile(join(configHome, "weft", "config.json"), JSON.stringify({ token: "weft_secret", deviceId: crypto.randomUUID() }));
    expect(await renewCliCredential({ env: { XDG_CONFIG_HOME: configHome }, fetch: fetcher }, "http://weft.example")).toBe("weft_secret");
    const messages: string[] = [];
    const status = await main(["bun", "weft", "--api-url", "http://weft.example", "--token", "weft_secret", "-w", "team", "list-projects"], {
      env: { XDG_CONFIG_HOME: configHome }, fetch: fetcher, stdout: (message) => messages.push(message), stderr: (message) => messages.push(message),
    });
    expect(status).toBe(1);
    expect(messages.join("")).toContain("require HTTPS");
    expect(calls).toBe(0);
  } finally { await rm(configHome, { recursive: true, force: true }); }
});

test.concurrent("a process crash releases the credential transaction lock", async () => {
  const configHome = await mkdtemp(join(tmpdir(), "weft-stale-lock-"));
  const directory = join(configHome, "weft");
  const configPath = join(directory, "config.json");
  const lockPath = `${configPath}.lockdb`;
  try {
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(configPath, JSON.stringify({ token: "weft_saved", deviceId: crypto.randomUUID() }), { mode: 0o600 });
    const child = Bun.spawn(["bun", "-e", `import { Database } from "bun:sqlite"; const db = new Database(${JSON.stringify(lockPath)}); db.exec("BEGIN IMMEDIATE"); console.log("locked"); setInterval(() => {}, 1000);`], { stdout: "pipe", stderr: "pipe" });
    const reader = child.stdout.getReader();
    await reader.read();
    child.kill("SIGKILL");
    await child.exited;
    const result = await renewCliCredential({ env: { XDG_CONFIG_HOME: configHome }, fetch: async () => new Response(JSON.stringify({ status: "current" }), { status: 200 }) }, "https://weft.example");
    expect(result).toBe("weft_saved");
  } finally { await rm(configHome, { recursive: true, force: true }); }
});

test.concurrent("expiry and address limits stop stale requests, code guesses, and excessive polling", async () => {
  await withRollback(db, async (transaction) => {
    const app = createApp(undefined, transaction);
    const call = (path: string, method: string, body?: unknown, headers: Record<string, string> = {}) => app.handle(new Request(`http://localhost${path}`, {
      method, headers: { ...(path.endsWith("/decision") ? { origin: "http://localhost:5173" } : {}), ...(body ? { "content-type": "application/json" } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}),
    }));
    const signedIn = await call("/api/auth/sign-up/email", "POST", { name: "Owner", email: `${crypto.randomUUID()}@example.test`, password: "a-secure-password" });
    const cookie = signedIn.headers.get("set-cookie")!.split(";")[0]!;
    const start = await call("/api/cli/device-authorization", "POST", { deviceId: crypto.randomUUID(), hostname: "test-host" });
    const request = await start.json() as { deviceSecret: string };
    for (let guess = 0; guess < 20; guess += 1) {
      expect((await call("/api/cli/device-authorization?code=AAAAAAAA", "GET", undefined, { cookie })).status).toBe(404);
    }
    expect((await call("/api/cli/device-authorization?code=AAAAAAAA", "GET", undefined, { cookie })).status).toBe(429);
    const polls = await Promise.all(Array.from({ length: 121 }, () => call("/api/cli/device-authorization/poll", "POST", { deviceSecret: request.deviceSecret })));
    expect(polls.filter((response) => response.status === 429).length).toBeGreaterThan(0);
    await transaction.update(cliDeviceAuthorizations).set({ expiresAt: new Date(Date.now() - 1) });
    const freshApp = createApp(undefined, transaction);
    const expired = await freshApp.handle(new Request("http://localhost/api/cli/device-authorization/poll", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ deviceSecret: request.deviceSecret }) }));
    expect(await expired.json()).toMatchObject({ status: "expired" });
    expect((await call("/api/cli/device-authorization/decision", "POST", { code: "AAAAAAAA", decision: "approve" }, { cookie })).status).toBe(404);
  });
});

test.concurrent("a lost cancellation is bounded by authorization expiry and cleanup preserves the prior credential and audit record", async () => {
  await withRollback(db, async (transaction) => {
    let now = Date.now();
    const app = createApp(undefined, transaction, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, { now: () => now });
    const call = (path: string, method: string, body?: unknown, headers: Record<string, string> = {}) => app.handle(new Request(`http://localhost${path}`, {
      method, headers: { ...(path.endsWith("/decision") ? { origin: "http://localhost:5173" } : {}), ...(body ? { "content-type": "application/json" } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}),
    }));
    const signedIn = await call("/api/auth/sign-up/email", "POST", { name: "Owner", email: `${crypto.randomUUID()}@example.test`, password: "a-secure-password" });
    const cookie = signedIn.headers.get("set-cookie")!.split(";")[0]!;
    const deviceId = crypto.randomUUID();
    const prior = await (await call("/actions/create_api_token", "POST", { name: "CLI @ same-host" }, { cookie })).json() as { id: string; token: string };
    const ownerId = (await (await call("/api/auth/get-session", "GET", undefined, { cookie })).json() as { user: { id: string } }).user.id;
    expect(await (await call("/api/cli/device-credentials/renew", "POST", {}, { authorization: `Bearer ${prior.token}` })).json()).toMatchObject({ status: "legacy" });
    expect((await transaction.select().from(apiTokens).where(eq(apiTokens.id, prior.id)))[0]?.expiresAt).toBeNull();
    await transaction.insert(cliDevices).values({ deviceId, ownerId, hostname: "same-host", tokenId: prior.id });
    const start = await call("/api/cli/device-authorization", "POST", { deviceId, hostname: "same-host" });
    const request = await start.json() as { userCode: string; deviceSecret: string };
    await call("/api/cli/device-authorization/decision", "POST", { code: request.userCode, decision: "approve" }, { cookie });
    const exchange = await (await call("/api/cli/device-authorization/exchange", "POST", { deviceSecret: request.deviceSecret })).json() as { token: string; exchangeId: string };
    expect((await call("/api/cli/device-credentials/renew", "POST", {}, { authorization: `Bearer ${exchange.token}` })).status).toBe(401);
    const priorRow = (await transaction.select().from(apiTokens).where(eq(apiTokens.id, prior.id)))[0];
    expect(priorRow?.revokedAt).toBeNull();
    expect(exchange.token).not.toBe(prior.token);
    const completedStart = await call("/api/cli/device-authorization", "POST", { deviceId: crypto.randomUUID(), hostname: "completed-device" });
    const completedRequest = await completedStart.json() as { userCode: string; deviceSecret: string };
    await call("/api/cli/device-authorization/decision", "POST", { code: completedRequest.userCode, decision: "approve" }, { cookie });
    const completedExchange = await (await call("/api/cli/device-authorization/exchange", "POST", { deviceSecret: completedRequest.deviceSecret })).json() as { token: string; exchangeId: string };
    expect((await call("/api/cli/device-authorization/finalize", "POST", { exchangeId: completedExchange.exchangeId }, { authorization: `Bearer ${completedExchange.token}` })).status).toBe(200);
    const authorization = (await transaction.select().from(cliDeviceAuthorizations).where(eq(cliDeviceAuthorizations.id, exchange.exchangeId)))[0]!;
    // The terminal lost the exchange response and its cancellation request cannot reach the server.
    now = authorization.expiresAt.getTime();
    await createJobHandlers(undefined, { now: () => new Date(now) }).cleanup_cli_device_authorizations!(transaction, {}, { id: "hourly", type: "cleanup_cli_device_authorizations" });
    expect((await transaction.select({ status: cliDeviceAuthorizations.status }).from(cliDeviceAuthorizations).where(eq(cliDeviceAuthorizations.id, authorization.id)))[0]?.status).toBe("expired");
    expect((await transaction.select({ revokedAt: apiTokens.revokedAt }).from(apiTokens).where(eq(apiTokens.id, authorization.tokenId!)))[0]?.revokedAt).toBeInstanceOf(Date);
    expect((await call("/api/cli/device-authorization/finalize", "POST", { exchangeId: authorization.id }, { authorization: `Bearer ${exchange.token}` })).status).toBe(410);
    expect((await call("/api/cli/device-credentials/renew", "POST", {}, { authorization: `Bearer ${prior.token}` })).status).toBe(200);
    expect((await call("/api/cli/device-credentials/renew", "POST", {}, { authorization: `Bearer ${completedExchange.token}` })).status).toBe(200);
    expect((await transaction.select().from(cliDeviceAuthorizations).where(eq(cliDeviceAuthorizations.id, authorization.id)))).toHaveLength(1);

    const delayedStart = await call("/api/cli/device-authorization", "POST", { deviceId: crypto.randomUUID(), hostname: "delayed-finalize" });
    const delayedRequest = await delayedStart.json() as { userCode: string; deviceSecret: string };
    await call("/api/cli/device-authorization/decision", "POST", { code: delayedRequest.userCode, decision: "approve" }, { cookie });
    const delayedExchange = await (await call("/api/cli/device-authorization/exchange", "POST", { deviceSecret: delayedRequest.deviceSecret })).json() as { token: string; exchangeId: string };
    const [delayedAuthorization] = await transaction.select().from(cliDeviceAuthorizations).where(eq(cliDeviceAuthorizations.id, delayedExchange.exchangeId));
    now = delayedAuthorization!.expiresAt.getTime();
    expect((await call("/api/cli/device-authorization/finalize", "POST", { exchangeId: delayedExchange.exchangeId }, { authorization: `Bearer ${delayedExchange.token}` })).status).toBe(410);
    expect((await transaction.select({ status: cliDeviceAuthorizations.status }).from(cliDeviceAuthorizations).where(eq(cliDeviceAuthorizations.id, delayedExchange.exchangeId)))[0]?.status).toBe("expired");
    expect((await transaction.select({ revokedAt: apiTokens.revokedAt }).from(apiTokens).where(eq(apiTokens.tokenHash, createHash("sha256").update(delayedExchange.token).digest("hex"))))[0]?.revokedAt).toBeInstanceOf(Date);
    expect((await call("/api/cli/device-credentials/renew", "POST", {}, { authorization: `Bearer ${prior.token}` })).status).toBe(200);
  });
});

test.concurrent("an active device rotates after 30 days and keeps the old credential until the replacement is finalized", async () => {
  await withRollback(db, async (transaction) => {
    const app = createApp(undefined, transaction);
    const call = (path: string, method: string, body?: unknown, headers: Record<string, string> = {}) => app.handle(new Request(`http://localhost${path}`, {
      method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}),
    }));
    const cookie = (await call("/api/auth/sign-up/email", "POST", { name: "Owner", email: `${crypto.randomUUID()}@example.test`, password: "a-secure-password" })).headers.get("set-cookie")!.split(";")[0]!;
    const deviceId = crypto.randomUUID();
    const started = await call("/api/cli/device-authorization", "POST", { deviceId, hostname: "rotation-host" });
    const request = await started.json() as { userCode: string; deviceSecret: string };
    await call("/api/cli/device-authorization/decision", "POST", { code: request.userCode, decision: "approve" }, { cookie, origin: "http://localhost:5173" });
    const issued = await (await call("/api/cli/device-authorization/exchange", "POST", { deviceSecret: request.deviceSecret })).json() as { token: string; exchangeId: string };
    await call("/api/cli/device-authorization/finalize", "POST", { exchangeId: issued.exchangeId }, { authorization: `Bearer ${issued.token}` });
    const [tokenRow] = await transaction.select().from(apiTokens).where(eq(apiTokens.tokenHash, createHash("sha256").update(issued.token).digest("hex")));
    await transaction.update(cliDevices).set({ lastUsedAt: new Date(Date.now() - 89 * 24 * 60 * 60_000) }).where(eq(cliDevices.tokenId, tokenRow!.id));
    await transaction.update(apiTokens).set({ expiresAt: new Date(Date.now() + 24 * 60 * 60_000) }).where(eq(apiTokens.id, tokenRow!.id));
    const registration = await call("/api/daemon/register", "POST", { hostname: "rotation-host", version: "1", agentClis: [] }, { authorization: `Bearer ${issued.token}` });
    expect(registration.status).toBe(200);
    const activeAfterRegistration = (await transaction.select().from(apiTokens).where(eq(apiTokens.id, tokenRow!.id)))[0]!;
    const deviceAfterRegistration = (await transaction.select().from(cliDevices).where(eq(cliDevices.tokenId, tokenRow!.id)))[0]!;
    expect(activeAfterRegistration.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 89 * 24 * 60 * 60_000);
    expect(deviceAfterRegistration.lastUsedAt.getTime()).toBeGreaterThan(Date.now() - 1_000);
    await transaction.update(apiTokens).set({ createdAt: new Date(Date.now() - 31 * 24 * 60 * 60_000) }).where(eq(apiTokens.id, tokenRow!.id));

    const configHome = await mkdtemp(join(tmpdir(), "weft-device-rotation-"));
    try {
      const configPath = join(configHome, "weft", "config.json");
      const { mkdir, writeFile } = await import("node:fs/promises");
      await mkdir(join(configHome, "weft"), { recursive: true, mode: 0o700 });
      await writeFile(configPath, `${JSON.stringify({ token: issued.token, apiUrl: "https://weft.example", deviceId })}\n`, { mode: 0o600 });
      const apiFetch = async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
        return app.handle(new Request(`http://localhost${url.pathname}${url.search}`, init));
      };
      expect(await renewCliCredential({ env: { XDG_CONFIG_HOME: configHome }, fetch: async () => { throw new Error("offline"); } }, "https://weft.example")).toBe(issued.token);
      expect(await renewCliCredential({ env: { XDG_CONFIG_HOME: configHome }, fetch: apiFetch, replaceConfig: async () => { throw new Error("disk is read-only"); } }, "https://weft.example")).toBe(issued.token);
      expect((JSON.parse(await readFile(configPath, "utf8")) as { token: string }).token).toBe(issued.token);
      expect((await call("/actions/list_authorized_apps", "POST", {}, { authorization: `Bearer ${issued.token}` })).status).toBe(403);
      await transaction.update(cliDeviceAuthorizations).set({ expiresAt: new Date(Date.now() - 1) }).where(eq(cliDeviceAuthorizations.status, "rotating"));
      let failFinalizeOnce = true;
      const interruptedFinalize = async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
        if (url.pathname.endsWith("/finalize") && failFinalizeOnce) { failFinalizeOnce = false; return new Response("offline", { status: 503 }); }
        return apiFetch(input, init);
      };
      const pending = await renewCliCredential({ env: { XDG_CONFIG_HOME: configHome }, fetch: interruptedFinalize }, "https://weft.example");
      expect(pending).toBe(issued.token);
      const interrupted = JSON.parse(await readFile(configPath, "utf8")) as { token: string; pendingCredential?: { token: string; exchangeId: string } };
      expect(interrupted.token).toBe(issued.token);
      expect(interrupted.pendingCredential?.token).toMatch(/^weft_/);
      expect((await call("/actions/list_authorized_apps", "POST", {}, { authorization: `Bearer ${issued.token}` })).status).toBe(403);
      const [replacement, concurrentReplacement] = await Promise.all([
        renewCliCredential({ env: { XDG_CONFIG_HOME: configHome }, fetch: apiFetch }, "https://weft.example"),
        renewCliCredential({ env: { XDG_CONFIG_HOME: configHome }, fetch: apiFetch }, "https://weft.example"),
      ]);
      expect(replacement).toMatch(/^weft_/);
      expect(concurrentReplacement).toBe(replacement);
      expect(replacement).not.toBe(issued.token);
      const replacementToken = replacement!;
      const saved = JSON.parse(await readFile(configPath, "utf8")) as { token: string; pendingRenewal?: string; pendingCredential?: unknown };
      expect(saved.token).toBe(replacementToken);
      expect(saved.pendingCredential).toBeUndefined();
      expect(saved.pendingRenewal).toBeUndefined();
      expect((await call("/actions/list_authorized_apps", "POST", {}, { authorization: `Bearer ${issued.token}` })).status).toBe(401);
      expect((await call("/actions/list_authorized_apps", "POST", {}, { authorization: `Bearer ${replacementToken}` })).status).toBe(403);
    } finally { await rm(configHome, { recursive: true, force: true }); }
  });
});

test.concurrent("terminal cancellation stops an approved request before the token exchange", async () => {
  await withRollback(db, async (transaction) => {
    const app = createApp(undefined, transaction);
    const call = (path: string, method: string, body?: unknown, headers: Record<string, string> = {}) => app.handle(new Request(`http://localhost${path}`, {
      method, headers: { ...(path.endsWith("/decision") ? { origin: "http://localhost:5173" } : {}), ...(body ? { "content-type": "application/json" } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}),
    }));
    const signedIn = await call("/api/auth/sign-up/email", "POST", { name: "Owner", email: `${crypto.randomUUID()}@example.test`, password: "a-secure-password" });
    const cookie = signedIn.headers.get("set-cookie")!.split(";")[0]!;
    const started = await call("/api/cli/device-authorization", "POST", { deviceId: crypto.randomUUID(), hostname: "test-host" });
    const request = await started.json() as { userCode: string; deviceSecret: string };
    expect((await call("/api/cli/device-authorization/decision", "POST", { code: request.userCode, decision: "approve" }, { cookie })).status).toBe(200);
    expect((await call("/api/cli/device-authorization/cancel", "POST", { deviceSecret: request.deviceSecret })).status).toBe(200);
    expect(await (await call("/api/cli/device-authorization/poll", "POST", { deviceSecret: request.deviceSecret })).json()).toMatchObject({ status: "cancelled" });
    expect((await call("/api/cli/device-authorization/exchange", "POST", { deviceSecret: request.deviceSecret })).status).toBe(409);
  });
});

test.concurrent("cancelling after exchange revokes the unfinalized credential and preserves the prior device credential", async () => {
  await withRollback(db, async (transaction) => {
    const app = createApp(undefined, transaction);
    const call = (path: string, method: string, body?: unknown, headers: Record<string, string> = {}) => app.handle(new Request(`http://localhost${path}`, {
      method, headers: { ...(path.endsWith("/decision") ? { origin: "http://localhost:5173" } : {}), ...(body ? { "content-type": "application/json" } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}),
    }));
    const signedIn = await call("/api/auth/sign-up/email", "POST", { name: "Owner", email: `${crypto.randomUUID()}@example.test`, password: "a-secure-password" });
    const cookie = signedIn.headers.get("set-cookie")!.split(";")[0]!;
    const deviceId = crypto.randomUUID();
    const enroll = async () => {
      const started = await call("/api/cli/device-authorization", "POST", { deviceId, hostname: "cancel-host" });
      const request = await started.json() as { userCode: string; deviceSecret: string };
      await call("/api/cli/device-authorization/decision", "POST", { code: request.userCode, decision: "approve" }, { cookie });
      const exchange = await call("/api/cli/device-authorization/exchange", "POST", { deviceSecret: request.deviceSecret });
      return { request, credential: await exchange.json() as { token: string; exchangeId: string } };
    };
    const first = await enroll();
    expect((await call("/api/cli/device-authorization/finalize", "POST", { exchangeId: first.credential.exchangeId }, { authorization: `Bearer ${first.credential.token}` })).status).toBe(200);
    const second = await enroll();
    expect((await call("/api/cli/device-authorization/cancel", "POST", { deviceSecret: second.request.deviceSecret })).status).toBe(200);
    expect([401, 409]).toContain((await call("/api/cli/device-authorization/finalize", "POST", { exchangeId: second.credential.exchangeId }, { authorization: `Bearer ${second.credential.token}` })).status);
    expect((await call("/api/cli/device-credentials/renew", "POST", {}, { authorization: `Bearer ${first.credential.token}` })).status).toBe(200);
    expect((await call("/api/cli/device-credentials/renew", "POST", {}, { authorization: `Bearer ${second.credential.token}` })).status).toBe(401);
    const [authorization] = await transaction.select({ status: cliDeviceAuthorizations.status, tokenId: cliDeviceAuthorizations.tokenId })
      .from(cliDeviceAuthorizations).where(eq(cliDeviceAuthorizations.id, second.credential.exchangeId));
    const [token] = await transaction.select({ revokedAt: apiTokens.revokedAt }).from(apiTokens).where(eq(apiTokens.id, authorization!.tokenId!));
    expect(authorization?.status).toBe("cancelled");
    expect(token?.revokedAt).toBeInstanceOf(Date);
  });
});

test.concurrent("cancellation racing finalize either preserves the old credential or reports the committed replacement", async () => {
  await withRollback(db, async (transaction) => {
    const app = createApp(undefined, transaction);
    const call = (path: string, method: string, body?: unknown, headers: Record<string, string> = {}) => app.handle(new Request(`http://localhost${path}`, {
      method, headers: { ...(path.endsWith("/decision") ? { origin: "http://localhost:5173" } : {}), ...(body ? { "content-type": "application/json" } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}),
    }));
    const signedIn = await call("/api/auth/sign-up/email", "POST", { name: "Owner", email: `${crypto.randomUUID()}@example.test`, password: "a-secure-password" });
    const cookie = signedIn.headers.get("set-cookie")!.split(";")[0]!;
    const deviceId = crypto.randomUUID();
    const enroll = async () => {
      const started = await call("/api/cli/device-authorization", "POST", { deviceId, hostname: "race-host" });
      const request = await started.json() as { userCode: string; deviceSecret: string };
      await call("/api/cli/device-authorization/decision", "POST", { code: request.userCode, decision: "approve" }, { cookie });
      const response = await call("/api/cli/device-authorization/exchange", "POST", { deviceSecret: request.deviceSecret });
      return { request, credential: await response.json() as { token: string; exchangeId: string } };
    };
    const original = await enroll();
    expect((await call("/api/cli/device-authorization/finalize", "POST", { exchangeId: original.credential.exchangeId }, { authorization: `Bearer ${original.credential.token}` })).status).toBe(200);
    const replacement = await enroll();
    const [finalizeResponse, cancelResponse] = await Promise.all([
      call("/api/cli/device-authorization/finalize", "POST", { exchangeId: replacement.credential.exchangeId }, { authorization: `Bearer ${replacement.credential.token}` }),
      call("/api/cli/device-authorization/cancel", "POST", { deviceSecret: replacement.request.deviceSecret }),
    ]);
    const [authorization] = await transaction.select({ status: cliDeviceAuthorizations.status }).from(cliDeviceAuthorizations).where(eq(cliDeviceAuthorizations.id, replacement.credential.exchangeId));
    if (authorization?.status === "completed") {
      expect(finalizeResponse.status).toBe(200);
      expect(await cancelResponse.json()).toMatchObject({ status: "completed" });
      expect((await call("/api/cli/device-credentials/renew", "POST", {}, { authorization: `Bearer ${replacement.credential.token}` })).status).toBe(200);
      expect((await call("/api/cli/device-credentials/renew", "POST", {}, { authorization: `Bearer ${original.credential.token}` })).status).toBe(401);
    } else {
      expect(authorization?.status).toBe("cancelled");
      expect(finalizeResponse.status).toBe(409);
      expect(await cancelResponse.json()).toMatchObject({ status: "cancelled" });
      expect((await call("/api/cli/device-credentials/renew", "POST", {}, { authorization: `Bearer ${original.credential.token}` })).status).toBe(200);
      expect((await call("/api/cli/device-credentials/renew", "POST", {}, { authorization: `Bearer ${replacement.credential.token}` })).status).toBe(401);
    }
  });
});

test.concurrent("enrolling the same local device under another account cannot revoke the first account's credential", async () => {
  await withRollback(db, async (transaction) => {
    const app = createApp(undefined, transaction);
    const call = (path: string, method: string, body?: unknown, headers: Record<string, string> = {}) => app.handle(new Request(`http://localhost${path}`, {
      method, headers: { ...(path.endsWith("/decision") ? { origin: "http://localhost:5173" } : {}), ...(body ? { "content-type": "application/json" } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}),
    }));
    const signup = async (name: string) => {
      const response = await call("/api/auth/sign-up/email", "POST", { name, email: `${crypto.randomUUID()}@example.test`, password: "a-secure-password" });
      return { cookie: response.headers.get("set-cookie")!.split(";")[0]!, userId: ((await (await call("/api/auth/get-session", "GET", undefined, { cookie: response.headers.get("set-cookie")!.split(";")[0]! })).json()) as { user: { id: string } }).user.id };
    };
    const firstAccount = await signup("First account");
    const secondAccount = await signup("Second account");
    const deviceId = crypto.randomUUID();
    const prior = await (await call("/actions/create_api_token", "POST", { name: "CLI @ shared-host" }, { cookie: firstAccount.cookie })).json() as { id: string };
    await transaction.insert(cliDevices).values({ deviceId, ownerId: firstAccount.userId, hostname: "shared-host", tokenId: prior.id });
    const started = await call("/api/cli/device-authorization", "POST", { deviceId, hostname: "shared-host" });
    const request = await started.json() as { userCode: string; deviceSecret: string };
    await call("/api/cli/device-authorization/decision", "POST", { code: request.userCode, decision: "approve" }, { cookie: secondAccount.cookie });
    const credential = await (await call("/api/cli/device-authorization/exchange", "POST", { deviceSecret: request.deviceSecret })).json() as { token: string; exchangeId: string };
    expect((await call("/api/cli/device-authorization/finalize", "POST", { exchangeId: credential.exchangeId }, { authorization: `Bearer ${credential.token}` })).status).toBe(200);
    expect((await transaction.select().from(apiTokens).where(eq(apiTokens.id, prior.id)))[0]?.revokedAt).toBeNull();
    expect(await transaction.select().from(cliDevices).where(eq(cliDevices.deviceId, deviceId))).toHaveLength(2);
  });
});

test.concurrent("a revoked Daemon may only acknowledge its pending device-revocation stop", async () => {
  await withRollback(db, async (transaction) => {
    const owner = await createUserFactory(transaction);
    const workspace = await createWorkspaceFactory(transaction);
    await transaction.insert(workspaceMembers).values({ workspaceId: workspace.id, userId: owner.id, role: "Admin" });
    const project = await createProjectActions(transaction).createProject.handler({ userId: owner.id }, { workspaceId: workspace.id, name: "Device cancellation", key: `DC${crypto.randomUUID().slice(0, 4).toUpperCase()}`, visibility: "private" });
    const cli = await mintApiToken(transaction, { userId: owner.id, name: "CLI @ connected-host", description: null });
    const deviceId = crypto.randomUUID();
    await transaction.insert(cliDevices).values({ deviceId, ownerId: owner.id, hostname: "connected-host", tokenId: cli.id });
    const daemonCredential = await mintApiToken(transaction, { userId: owner.id, name: "Daemon @ connected-host", description: null, daemonOnly: true, cliDeviceId: deviceId });
    const [daemon] = await transaction.insert(daemons).values({ ownerId: owner.id, tokenId: daemonCredential.id, hostname: "connected-host", version: "1", cliDeviceId: deviceId }).returning();
    const [runtime] = await transaction.insert(runtimes).values({ workspaceId: workspace.id, daemonId: daemon!.id, ownerId: owner.id, agentCli: "codex" }).returning();
    const [run] = await transaction.insert(runs).values({ workspaceId: workspace.id, projectId: project.id, originatorId: owner.id, runtimeId: runtime!.id, status: "stopping", failureReason: "cli_device_revoked", startedAt: new Date() }).returning();
    const app = createApp(undefined, transaction);
    const call = (path: string, bearer: string, body: unknown) => app.handle(new Request(`http://localhost${path}`, {
      method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" }, body: JSON.stringify(body),
    }));
    expect((await call("/api/daemon/runs/cancellations", daemonCredential.token, {})).status).toBe(401);
    await createApiTokenActions(transaction).revokeCliDevice.handler({ userId: owner.id }, { deviceId });

    expect(await (await call("/api/daemon/runs/cancellations", daemonCredential.token, {})).json()).toEqual({ runIds: [run!.id] });
    expect((await call("/api/daemon/runs/claim", daemonCredential.token, {})).status).toBe(401);
    expect((await call("/api/daemon/runs/cancel-ack", daemonCredential.token, { runId: crypto.randomUUID() })).status).toBe(401);
    await sweepRuntimeRuns(transaction, () => new Date(Date.now() + 200_000));
    expect(await (await call("/api/daemon/runs/cancellations", daemonCredential.token, {})).json()).toEqual({ runIds: [run!.id] });
    expect((await call("/api/daemon/runs/cancel-ack", daemonCredential.token, { runId: run!.id })).status).toBe(200);
    expect(await transaction.select({ status: runs.status, failureReason: runs.failureReason }).from(runs).where(eq(runs.id, run!.id)))
      .toEqual([{ status: "cancelled", failureReason: "cli_device_revoked_confirmed" }]);

    const legacyCredential = await mintApiToken(transaction, { userId: owner.id, name: "Daemon @ legacy-host", description: null, daemonOnly: true });
    const [legacyDaemon] = await transaction.insert(daemons).values({ ownerId: owner.id, tokenId: legacyCredential.id, hostname: "legacy-host", version: "1" }).returning();
    const [legacyRuntime] = await transaction.insert(runtimes).values({ workspaceId: workspace.id, daemonId: legacyDaemon!.id, ownerId: owner.id, agentCli: "claude" }).returning();
    const [legacyRun] = await transaction.insert(runs).values({ workspaceId: workspace.id, projectId: project.id, originatorId: owner.id, runtimeId: legacyRuntime!.id, status: "stopping", failureReason: "cli_device_revoked" }).returning();
    await createApiTokenActions(transaction).revokeApiToken.handler({ userId: owner.id }, { tokenId: legacyCredential.id });
    expect(await (await call("/api/daemon/runs/cancellations", legacyCredential.token, {})).json()).toEqual({ runIds: [legacyRun!.id] });
    expect((await call("/api/daemon/runs/cancel-ack", legacyCredential.token, { runId: legacyRun!.id })).status).toBe(200);
    expect(await transaction.select({ status: runs.status, failureReason: runs.failureReason }).from(runs).where(eq(runs.id, legacyRun!.id)))
      .toEqual([{ status: "cancelled", failureReason: "daemon_credential_revoked_confirmed" }]);
  });
});
