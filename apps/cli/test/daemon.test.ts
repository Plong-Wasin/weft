import { afterAll, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childEnvironment, consumeRedactedOutput, daemonStatus, login, redactRuntimeEnvironment, renewCliCredential, startDaemon, startDaemonBackground, stopDaemon } from "../src/daemon";
import { agentCliAdapters } from "../src/agent-cli";
import { main } from "../src/program";

const scratch: string[] = [];
/** A fresh Daemon config folder, so no test writes a credential into the developer's real ~/.config/weft. */
const isolatedConfig = async () => { const directory = await mkdtemp(join(tmpdir(), "weft-daemon-config-")); scratch.push(directory); return directory; };
afterAll(async () => { await Promise.all(scratch.map((path) => rm(path, { recursive: true, force: true }))); });

test("weft login prints the device code and stores a private device credential", async () => {
  const configHome = await mkdtemp(join(tmpdir(), "weft-login-")); scratch.push(configHome);
  const logs: string[] = [];
  const apiFetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.pathname.endsWith("/device-authorization") && init?.method === "POST") return Response.json({ deviceSecret: "terminal-secret", userCode: "ABCD2345", verificationUrl: "https://weft.example/cli/authorize?code=ABCD2345", expiresAt: new Date(Date.now() + 300_000).toISOString(), interval: 2 }, { status: 201 });
    if (url.pathname.endsWith("/poll")) return Response.json({ status: "approved" });
    if (url.pathname.endsWith("/exchange")) return Response.json({ token: "weft_test_token", exchangeId: "exchange-id" });
    if (url.pathname.endsWith("/finalize")) return Response.json({ status: "completed" });
    return Response.json({ error: "Unexpected request" }, { status: 404 });
  };
  await login({ env: { WEFT_API_URL: "https://weft.example", XDG_CONFIG_HOME: configHome, WEFT_HOSTNAME: "devbox" }, fetch: apiFetch, sleep: async () => {}, stdout: (text) => logs.push(text), openBrowser: async (url) => {
    expect(url).toContain("ABCD2345");
  } });
  const saved = JSON.parse(await readFile(join(configHome, "weft/config.json"), "utf8"));
  expect(saved).toMatchObject({ token: "weft_test_token", apiUrl: "https://weft.example" });
  expect(saved.deviceId).toMatch(/^[0-9a-f-]{36}$/i);
  expect(logs.join("")).toContain("Signed in to https://weft.example");
  expect(logs.join("")).toContain("Enter code: ABCD2345");
  expect(logs.join("")).not.toContain("weft_test_token");
});

test("weft login keeps the saved credential on denial, expiry, polling failure, and exchange failure", async () => {
  const previous = { token: "weft_previous_credential", apiUrl: "https://weft.example", deviceId: crypto.randomUUID() };
  for (const failure of ["poll", "exchange", "denied", "expired"] as const) {
    const configHome = await mkdtemp(join(tmpdir(), `weft-login-${failure}-`)); scratch.push(configHome);
    const directory = join(configHome, "weft"); await mkdir(directory, { recursive: true, mode: 0o700 });
    const configPath = join(directory, "config.json");
    await writeFile(configPath, `${JSON.stringify(previous)}\n`, { mode: 0o600 });
    const fetcher = async (input: string | URL | Request) => {
      const url = new URL(input.toString());
      if (url.pathname.endsWith("/device-authorization")) return Response.json({ deviceSecret: "device-secret", userCode: "ABCD2345", verificationUrl: "https://weft.example/cli/authorize?code=ABCD2345", interval: 2 });
      if (url.pathname.endsWith("/poll")) {
        if (failure === "poll") return Response.json({ error: "temporarily unavailable" }, { status: 503 });
        return Response.json({ status: failure === "denied" || failure === "expired" ? failure : "approved" });
      }
      if (url.pathname.endsWith("/exchange")) return Response.json({ error: "exchange unavailable" }, { status: 503 });
      throw new Error(`Unexpected URL: ${url.pathname}`);
    };
    const expected = failure === "poll" ? "Could not check sign-in status" : failure === "exchange" ? "credential exchange failed" : failure === "denied" ? "Sign-in was denied" : "Sign-in request expired";
    await expect(login({ env: { XDG_CONFIG_HOME: configHome }, fetch: fetcher, sleep: async () => {}, openBrowser: async () => {} })).rejects.toThrow(expected);
    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual(previous);
  }
});

test("Ctrl+C cancels the device request and leaves the previous credential in place", async () => {
  const configHome = await mkdtemp(join(tmpdir(), "weft-login-cancel-")); scratch.push(configHome);
  const directory = join(configHome, "weft"); await mkdir(directory, { recursive: true, mode: 0o700 });
  const previous = { token: "weft_previous", apiUrl: "https://weft.example", deviceId: crypto.randomUUID() };
  const configPath = join(directory, "config.json"); await writeFile(configPath, `${JSON.stringify(previous)}\n`, { mode: 0o600 });
  let cancelled = false;
  const fetcher = async (input: string | URL | Request) => {
    const url = new URL(input.toString());
    if (url.pathname.endsWith("/device-authorization")) return Response.json({ deviceSecret: "device-secret", userCode: "ABCD2345", verificationUrl: "https://weft.example/cli/authorize?code=ABCD2345", interval: 2 });
    if (url.pathname.endsWith("/cancel")) { cancelled = true; return Response.json({ status: "cancelled" }); }
    throw new Error(`Unexpected request: ${url.pathname}`);
  };
  const output: string[] = [];
  await login({ env: { XDG_CONFIG_HOME: configHome }, fetch: fetcher, signal: AbortSignal.abort(), stdout: (text) => output.push(text), openBrowser: async () => {} });
  expect(cancelled).toBe(true);
  expect(output.join("")).toContain("Sign-in cancelled");
  expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual(previous);
});

test("Ctrl+C during waiting or polling cannot complete an approved sign-in", async () => {
  for (const phase of ["sleep", "poll"] as const) {
    const configHome = await isolatedConfig();
    const controller = new AbortController();
    let cancelled = false;
    let exchanged = false;
    const fetcher = async (input: string | URL | Request) => {
      const path = new URL(input.toString()).pathname;
      if (path.endsWith("/device-authorization")) return Response.json({ deviceSecret: "device-secret", userCode: "ABCD2345", verificationUrl: "https://weft.example/cli/authorize?code=ABCD2345", interval: 2 });
      if (path.endsWith("/poll")) { if (phase === "poll") controller.abort(); return Response.json({ status: "approved" }); }
      if (path.endsWith("/cancel")) { cancelled = true; return Response.json({ status: "cancelled" }); }
      if (path.endsWith("/exchange")) { exchanged = true; return Response.json({ token: "unexpected", exchangeId: "unexpected" }); }
      throw new Error(`Unexpected request: ${path}`);
    };
    await login({ env: { XDG_CONFIG_HOME: configHome }, fetch: fetcher, signal: controller.signal, sleep: async () => { if (phase === "sleep") controller.abort(); }, stdout: () => {}, openBrowser: async () => {} });
    expect(cancelled).toBe(true);
    expect(exchanged).toBe(false);
  }
});

test("Ctrl+C interrupts an in-flight approval poll", async () => {
  const configHome = await isolatedConfig();
  const controller = new AbortController();
  let cancelled = false;
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(input.toString()).pathname;
    if (path.endsWith("/device-authorization")) return Response.json({ deviceSecret: "device-secret", userCode: "ABCD2345", verificationUrl: "https://weft.example/cli/authorize?code=ABCD2345", interval: 2 });
    if (path.endsWith("/poll")) return await new Promise<Response>((_resolve, reject) => {
      if (!init?.signal) { reject(new Error("Poll cannot be interrupted")); return; }
      init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      controller.abort();
    });
    if (path.endsWith("/cancel")) { cancelled = true; return Response.json({ status: "cancelled" }); }
    throw new Error(`Unexpected request: ${path}`);
  };
  await login({ env: { XDG_CONFIG_HOME: configHome }, fetch: fetcher, signal: controller.signal, sleep: async () => {}, stdout: () => {}, openBrowser: async () => {} });
  expect(cancelled).toBe(true);
});

test("Ctrl+C during a held credential exchange cancels the exchange and preserves the installed credential", async () => {
  const configHome = await mkdtemp(join(tmpdir(), "weft-login-held-exchange-")); scratch.push(configHome);
  const directory = join(configHome, "weft"); await mkdir(directory, { recursive: true, mode: 0o700 });
  const previous = { token: "weft_previous", apiUrl: "https://weft.example", deviceId: crypto.randomUUID() };
  const configPath = join(directory, "config.json"); await writeFile(configPath, `${JSON.stringify(previous)}\n`, { mode: 0o600 });
  const controller = new AbortController();
  let reachExchange!: () => void;
  const exchangeReached = new Promise<void>((resolve) => { reachExchange = resolve; });
  let cancelled = false;
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(input.toString()).pathname;
    if (path.endsWith("/device-authorization")) return Response.json({ deviceSecret: "device-secret", userCode: "ABCD2345", verificationUrl: "https://weft.example/cli/authorize?code=ABCD2345", interval: 2 });
    if (path.endsWith("/poll")) return Response.json({ status: "approved" });
    if (path.endsWith("/exchange")) {
      expect(init?.signal).toBe(controller.signal);
      reachExchange();
      return await new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    }
    if (path.endsWith("/cancel")) { cancelled = true; return Response.json({ status: "cancelled" }); }
    throw new Error(`Unexpected request: ${path}`);
  };
  const loginPromise = login({ env: { XDG_CONFIG_HOME: configHome }, fetch: fetcher, signal: controller.signal, sleep: async () => {}, stdout: () => {}, openBrowser: async () => {} });
  await exchangeReached;
  controller.abort();
  await loginPromise;
  expect(cancelled).toBe(true);
  expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual(previous);
});

test("the actual CLI SIGINT handler aborts a held exchange", async () => {
  const configHome = await mkdtemp(join(tmpdir(), "weft-login-sigint-")); scratch.push(configHome);
  let cancelled = false;
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(input.toString()).pathname;
    if (path.endsWith("/device-authorization")) return Response.json({ deviceSecret: "device-secret", userCode: "ABCD2345", verificationUrl: "https://weft.example/cli/authorize?code=ABCD2345", interval: 2 });
    if (path.endsWith("/poll")) return Response.json({ status: "approved" });
    if (path.endsWith("/exchange")) return await new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      setTimeout(() => process.emit("SIGINT"), 0);
    });
    if (path.endsWith("/cancel")) { cancelled = true; return Response.json({ status: "cancelled" }); }
    throw new Error(`Unexpected request: ${path}`);
  };
  const errors: string[] = [];
  const status = await main(["bun", "weft", "--api-url", "https://weft.example", "login"], {
    env: { XDG_CONFIG_HOME: configHome }, fetch: fetcher, stdout: () => {}, stderr: (text) => errors.push(text), openBrowser: async () => {},
  });
  expect(status).toBe(0);
  expect(cancelled).toBe(true);
  expect(errors).toEqual([]);
});

test("a lost exchange response is cancelled so its unfinalized credential cannot be stranded", async () => {
  const configHome = await mkdtemp(join(tmpdir(), "weft-login-lost-exchange-")); scratch.push(configHome);
  const previous = { token: "weft_previous", apiUrl: "https://weft.example", deviceId: crypto.randomUUID() };
  const directory = join(configHome, "weft"); await mkdir(directory, { recursive: true, mode: 0o700 });
  const configPath = join(directory, "config.json"); await writeFile(configPath, `${JSON.stringify(previous)}\n`, { mode: 0o600 });
  let exchangeCommitted = false;
  let credentialRevoked = false;
  const fetcher = async (input: string | URL | Request) => {
    const path = new URL(input.toString()).pathname;
    if (path.endsWith("/device-authorization")) return Response.json({ deviceSecret: "device-secret", userCode: "ABCD2345", verificationUrl: "https://weft.example/cli/authorize?code=ABCD2345", interval: 2 });
    if (path.endsWith("/poll")) return Response.json({ status: "approved" });
    if (path.endsWith("/exchange")) { exchangeCommitted = true; throw new Error("response lost after commit"); }
    if (path.endsWith("/cancel")) { credentialRevoked = exchangeCommitted; return Response.json({ status: "cancelled" }); }
    throw new Error(`Unexpected request: ${path}`);
  };
  await expect(login({ env: { XDG_CONFIG_HOME: configHome }, fetch: fetcher, sleep: async () => {}, stdout: () => {}, openBrowser: async () => {} })).rejects.toThrow("unused credential was revoked");
  expect(exchangeCommitted).toBe(true);
  expect(credentialRevoked).toBe(true);
  expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual(previous);
});

test("a failed atomic config replacement leaves the old credential saved and never finalizes server replacement", async () => {
  const configHome = await mkdtemp(join(tmpdir(), "weft-login-save-failure-")); scratch.push(configHome);
  const directory = join(configHome, "weft"); await mkdir(directory, { recursive: true, mode: 0o700 });
  const previous = { token: "weft_previous", apiUrl: "https://weft.example", deviceId: crypto.randomUUID() };
  const configPath = join(directory, "config.json"); await writeFile(configPath, `${JSON.stringify(previous)}\n`, { mode: 0o600 });
  let finalized = false;
  const fetcher = async (input: string | URL | Request) => {
    const url = new URL(input.toString());
    if (url.pathname.endsWith("/device-authorization")) return Response.json({ deviceSecret: "device-secret", userCode: "ABCD2345", verificationUrl: "https://weft.example/cli/authorize?code=ABCD2345", interval: 2 });
    if (url.pathname.endsWith("/poll")) return Response.json({ status: "approved" });
    if (url.pathname.endsWith("/exchange")) return Response.json({ token: "weft_new", exchangeId: "exchange-id" });
    if (url.pathname.endsWith("/finalize")) { finalized = true; return Response.json({ status: "completed" }); }
    throw new Error(`Unexpected request: ${url.pathname}`);
  };
  await expect(login({ env: { XDG_CONFIG_HOME: configHome }, fetch: fetcher, sleep: async () => {}, openBrowser: async () => {}, replaceConfig: async () => { throw new Error("filesystem refused replacement"); } })).rejects.toThrow("credential could not be saved");
  expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual(previous);
  expect(finalized).toBe(false);
});

test("the global --api-url option selects the server for device sign-in", async () => {
  const configHome = await mkdtemp(join(tmpdir(), "weft-login-server-")); scratch.push(configHome);
  const urls: string[] = [];
  let browserUrl = "";
  const fetcher = async (input: string | URL | Request) => {
    const url = new URL(input.toString()); urls.push(url.toString());
    if (url.pathname.endsWith("/device-authorization")) return Response.json({ deviceSecret: "device-secret", userCode: "ABCD2345", verificationUrl: "https://selected.example/cli/authorize?code=ABCD2345", interval: 2 }, { status: 201 });
    if (url.pathname.endsWith("/poll")) return Response.json({ status: "approved" });
    if (url.pathname.endsWith("/exchange")) return Response.json({ token: "weft_selected", exchangeId: "exchange-id" });
    if (url.pathname.endsWith("/finalize")) return Response.json({ status: "completed" });
    return Response.json({ error: "Unexpected request" }, { status: 404 });
  };
  const status = await main(["bun", "weft", "--api-url", "https://selected.example", "login"], {
    env: { XDG_CONFIG_HOME: configHome }, fetch: fetcher, openBrowser: (url) => { browserUrl = url; }, stdout: () => {}, stderr: () => {}, signal: new AbortController().signal,
  });
  expect(status).toBe(0);
  expect(urls.every((url) => url.startsWith("https://selected.example/"))).toBe(true);
  expect(browserUrl).toStartWith("https://selected.example/");
  expect(JSON.parse(await readFile(join(configHome, "weft/config.json"), "utf8")).apiUrl).toBe("https://selected.example");
});

test("ordinary CLI commands never send a saved server A credential to explicit server B", async () => {
  const configHome = await isolatedConfig();
  const secret = "weft_saved_server_a_secret";
  await mkdir(join(configHome, "weft"), { recursive: true });
  await writeFile(join(configHome, "weft", "config.json"), JSON.stringify({ token: secret, apiUrl: "https://server-a.example" }));
  const requests: Array<{ url: string; authorization: string | null }> = [];
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") });
    return Response.json([]);
  };
  const errors: string[] = [];
  const status = await main(["bun", "weft", "--api-url", "https://server-b.example", "list-states", "--project-id", "project"], {
    env: { XDG_CONFIG_HOME: configHome }, fetch: fetcher, stdout: () => {}, stderr: (text) => errors.push(text),
  });
  expect(status).toBe(1);
  expect(requests).toEqual([]);
  expect(errors.join("")).toContain("saved Weft sign-in is for https://server-a.example");
  expect(errors.join("")).not.toContain(secret);
});

test("ordinary CLI commands require sign-in for a legacy credential whose server is unknown", async () => {
  const configHome = await isolatedConfig();
  await mkdir(join(configHome, "weft"), { recursive: true });
  const secret = "weft_legacy_unknown_server_secret";
  await writeFile(join(configHome, "weft", "config.json"), JSON.stringify({ token: secret, deviceId: "legacy-device" }));
  let requests = 0;
  const errors: string[] = [];
  const status = await main(["bun", "weft", "--api-url", "https://server-b.example", "list-states", "--project-id", "project"], {
    env: { XDG_CONFIG_HOME: configHome }, fetch: async () => { requests++; return Response.json([]); }, stdout: () => {}, stderr: (text) => errors.push(text),
  });
  expect(status).toBe(1);
  expect(requests).toBe(0);
  expect(errors.join("")).toContain("legacy Weft sign-in has no recorded server");
  expect(errors.join("")).not.toContain(secret);
});

test("explicit CLI and environment tokens remain usable against a selected server", async () => {
  const configHome = await isolatedConfig();
  const savedSecret = "weft_saved_server_a_secret";
  await mkdir(join(configHome, "weft"), { recursive: true });
  await writeFile(join(configHome, "weft", "config.json"), JSON.stringify({ token: savedSecret, apiUrl: "https://server-a.example" }));
  for (const [args, env, expected] of [
    [["--token", "weft_flag_server_b", "list-states", "--project-id", "project"], {}, "weft_flag_server_b"],
    [["list-states", "--project-id", "project"], { WEFT_TOKEN: "weft_env_server_b" }, "weft_env_server_b"],
  ] as const) {
    const requests: Array<{ url: string; authorization: string | null; redirect: RequestRedirect | undefined }> = [];
    const status = await main(["bun", "weft", "--api-url", "https://server-b.example", ...args], {
      env: { XDG_CONFIG_HOME: configHome, ...env },
      fetch: async (input, init) => { requests.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization"), redirect: init?.redirect }); return Response.json([]); },
      stdout: () => {}, stderr: () => {},
    });
    expect(status).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ url: "https://server-b.example/actions/list_states", authorization: `Bearer ${expected}`, redirect: "error" });
    expect(JSON.stringify(requests)).not.toContain(savedSecret);
  }
});

test("same-origin saved CLI credentials still work and authenticated requests refuse redirects", async () => {
  const configHome = await isolatedConfig();
  await mkdir(join(configHome, "weft"), { recursive: true });
  await writeFile(join(configHome, "weft", "config.json"), JSON.stringify({ token: "weft_server_a", apiUrl: "https://server-a.example" }));
  const requests: Array<{ url: string; authorization: string | null; redirect: RequestRedirect | undefined }> = [];
  const status = await main(["bun", "weft", "--api-url", "https://server-a.example", "list-states", "--project-id", "project"], {
    env: { XDG_CONFIG_HOME: configHome },
    fetch: async (input, init) => { requests.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization"), redirect: init?.redirect }); return Response.json([]); },
    stdout: () => {}, stderr: () => {},
  });
  expect(status).toBe(0);
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ url: "https://server-a.example/actions/list_states", authorization: "Bearer weft_server_a", redirect: "error" });
});

test("denied or cancelled legacy login keeps its unknown-server config byte-for-byte", async () => {
  for (const result of ["denied", "cancelled"] as const) {
    const configHome = await isolatedConfig();
    const configPath = join(configHome, "weft", "config.json");
    await mkdir(join(configHome, "weft"), { recursive: true });
    const legacy = '{"token":"weft_legacy_unknown_server","deviceId":"legacy-device"}\n';
    await writeFile(configPath, legacy);
    const fetcher = async (input: string | URL | Request) => {
      const path = new URL(input.toString()).pathname;
      if (path.endsWith("/device-authorization")) return Response.json({ deviceSecret: "device-secret", userCode: "ABCD2345", verificationUrl: "https://server-b.example/cli/authorize?code=ABCD2345", interval: 2 }, { status: 201 });
      if (path.endsWith("/poll")) return Response.json({ status: result });
      if (path.endsWith("/cancel")) return Response.json({ status: "cancelled" });
      throw new Error(`Unexpected request to ${path}`);
    };
    if (result === "denied") {
      await expect(login({ env: { XDG_CONFIG_HOME: configHome, WEFT_API_URL: "https://server-b.example" }, fetch: fetcher, sleep: async () => {}, stdout: () => {}, openBrowser: async () => {} })).rejects.toThrow("Sign-in was denied");
    } else {
      await login({ env: { XDG_CONFIG_HOME: configHome, WEFT_API_URL: "https://server-b.example" }, fetch: fetcher, signal: AbortSignal.abort(), sleep: async () => {}, stdout: () => {}, openBrowser: async () => {} });
    }
    expect(await readFile(configPath, "utf8")).toBe(legacy);
  }
});

test("pending recovery sends only its candidate token to the candidate server and never falls back cross-origin", async () => {
  const configHome = await isolatedConfig();
  await mkdir(join(configHome, "weft"), { recursive: true });
  const oldToken = "weft_server_a_secret";
  const candidateToken = "weft_server_b_candidate";
  await writeFile(join(configHome, "weft", "config.json"), JSON.stringify({
    token: oldToken, apiUrl: "https://server-a.example", deviceId: crypto.randomUUID(),
    pendingCredential: { token: candidateToken, exchangeId: "exchange-b", apiUrl: "https://server-b.example", deviceId: crypto.randomUUID() },
  }));
  const requests: Array<{ url: string; authorization: string | null }> = [];
  await expect(renewCliCredential({ env: { XDG_CONFIG_HOME: configHome }, fetch: async (input, init) => {
    requests.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") });
    return Response.json({ error: "not finalized" }, { status: 503 });
  } }, "https://server-b.example")).rejects.toThrow("awaiting server confirmation");
  expect(requests).toEqual([{ url: "https://server-b.example/api/cli/device-authorization/finalize", authorization: `Bearer ${candidateToken}` }]);
  expect(JSON.stringify(requests)).not.toContain(oldToken);
  expect(JSON.parse(await readFile(join(configHome, "weft", "config.json"), "utf8")).token).toBe(oldToken);
});

test("concurrent renewal calls recover a pending credential once before using the installed replacement", async () => {
  const configHome = await isolatedConfig();
  await mkdir(join(configHome, "weft"), { recursive: true });
  const deviceId = crypto.randomUUID();
  await writeFile(join(configHome, "weft", "config.json"), JSON.stringify({
    token: "weft_old", apiUrl: "https://server-a.example", deviceId,
    pendingCredential: { token: "weft_candidate", exchangeId: "exchange-a", apiUrl: "https://server-a.example", deviceId },
  }));
  const calls: Array<{ path: string; authorization: string | null }> = [];
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input.toString());
    calls.push({ path: url.pathname, authorization: new Headers(init?.headers).get("authorization") });
    if (url.pathname.endsWith("/finalize")) return Response.json({ status: "completed" });
    if (url.pathname.endsWith("/renew")) return Response.json({ status: "active" });
    throw new Error(`Unexpected request: ${url.pathname}`);
  };
  const results = await Promise.all([
    renewCliCredential({ env: { XDG_CONFIG_HOME: configHome }, fetch: fetcher }, "https://server-a.example"),
    renewCliCredential({ env: { XDG_CONFIG_HOME: configHome }, fetch: fetcher }, "https://server-a.example"),
  ]);
  expect(results).toEqual(["weft_candidate", "weft_candidate"]);
  expect(calls.filter((call) => call.path.endsWith("/finalize"))).toEqual([{ path: "/api/cli/device-authorization/finalize", authorization: "Bearer weft_candidate" }]);
  expect(calls.every((call) => call.authorization !== "Bearer weft_old")).toBe(true);
  expect(JSON.parse(await readFile(join(configHome, "weft", "config.json"), "utf8"))).toMatchObject({ token: "weft_candidate", apiUrl: "https://server-a.example", deviceId });
});

test("daemon status reports a live record and removes a stale record", async () => {
  const configHome = await mkdtemp(join(tmpdir(), "weft-status-")); scratch.push(configHome);
  const directory = join(configHome, "weft"); await mkdir(directory, { recursive: true });
  const recordPath = join(directory, "daemon.json");
  await writeFile(recordPath, JSON.stringify({ pid: process.pid, startedAt: new Date(Date.now() - 65_000).toISOString(), apiUrl: "https://weft.example", agentClis: ["claude"], logPath: join(directory, "daemon.log") }));
  expect(await daemonStatus({ env: { XDG_CONFIG_HOME: configHome } })).toMatchObject({ running: true, pid: process.pid, agentClis: ["claude"], server: "https://weft.example" });
  await writeFile(recordPath, JSON.stringify({ pid: 2_000_000_000, startedAt: new Date().toISOString(), apiUrl: "https://weft.example", agentClis: [], logPath: join(directory, "daemon.log") }));
  expect(await daemonStatus({ env: { XDG_CONFIG_HOME: configHome } })).toMatchObject({ running: false, logPath: join(directory, "daemon.log") });
  await expect(readFile(recordPath, "utf8")).rejects.toThrow();
});

test("daemon status has clear human output and machine-readable JSON", async () => {
  const configHome = await mkdtemp(join(tmpdir(), "weft-status-output-")); scratch.push(configHome);
  const directory = join(configHome, "weft"); await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "daemon.json"), JSON.stringify({ pid: process.pid, startedAt: new Date(Date.now() - 61_000).toISOString(), apiUrl: "https://weft.example", agentClis: ["claude", "codex"], logPath: join(directory, "daemon.log") }));
  const invoke = async (args: string[]) => {
    const out: string[] = [];
    await main(["bun", "weft", "daemon", "status", ...args], { env: { XDG_CONFIG_HOME: configHome }, stdout: (text) => out.push(text), stderr: () => {} });
    return out.join("");
  };
  const human = await invoke([]);
  expect(human).toContain(`Daemon is running as process ${process.pid}`);
  expect(human).toContain("Agent CLIs: claude, codex");
  expect(human).toContain("Signed in to: https://weft.example");
  expect(JSON.parse(await invoke(["--json"]))).toMatchObject({ running: true, pid: process.pid, agentClis: ["claude", "codex"], server: "https://weft.example" });
});

test("a second stop explains that the Daemon is not running and how to start it", async () => {
  const configHome = await mkdtemp(join(tmpdir(), "weft-stop-empty-")); scratch.push(configHome);
  const output: string[] = [];
  expect(await stopDaemon({ env: { XDG_CONFIG_HOME: configHome }, stdout: (text) => output.push(text) })).toBe(false);
  expect(output.join("")).toContain("Daemon is not running");
  expect(output.join("")).toContain("weft daemon start");
});

test("background start records a private log and process file, and refuses a second start", async () => {
  const configHome = await mkdtemp(join(tmpdir(), "weft-background-")); scratch.push(configHome);
  const outputs: string[] = [];
  const env = { XDG_CONFIG_HOME: configHome, WEFT_TOKEN: "daemon-test-token", WEFT_API_URL: "https://weft.example", PATH: Bun.env.PATH };
  let spawnedArgs: string[] = [];
  let detached = false;
  const fakeSpawn = (argv: string[], options?: { detached?: boolean }) => { spawnedArgs = argv; detached = Boolean(options?.detached); return { pid: process.pid, unref() {} }; };
  const record = await startDaemonBackground({ env, stdout: (text) => outputs.push(text), backgroundSpawn: fakeSpawn });
  expect(spawnedArgs.slice(-2)).toEqual(["start", "--foreground"]);
  expect(detached).toBe(true);
  expect((await daemonStatus({ env })).running).toBe(true);
  await expect(startDaemonBackground({ env, stdout: () => {}, backgroundSpawn: fakeSpawn })).rejects.toThrow(`process ${record.pid}`);
  const file = await readFile(join(configHome, "weft", "daemon.json"), "utf8");
  const log = await readFile(join(configHome, "weft", "daemon.log"), "utf8");
  expect(file).not.toContain("daemon-test-token");
  expect(log).not.toContain("daemon-test-token");
  await expect((await import("node:fs/promises")).stat(join(configHome, "weft", "daemon.json")).then((stat) => stat.mode & 0o777)).resolves.toBe(0o600);
  await expect((await import("node:fs/promises")).stat(join(configHome, "weft", "daemon.log")).then((stat) => stat.mode & 0o777)).resolves.toBe(0o600);
  expect(outputs.join("")).toContain(record.logPath);
  await rm(join(configHome, "weft"), { recursive: true, force: true });
});

test("background start returns while a separate Daemon registers with a fake server, and stop ends it", async () => {
  const configHome = await mkdtemp(join(tmpdir(), "weft-daemon-blackbox-")); scratch.push(configHome);
  let registrations = 0;
  let stopRequests = 0;
  let websocketTarget = "";
  let websocketAuthorization = "";
  const server = Bun.serve({
    port: 0,
    fetch(request, instance) {
      const path = new URL(request.url).pathname;
      if (path === "/api/daemon") {
        websocketTarget = request.url;
        websocketAuthorization = request.headers.get("authorization") ?? "";
        return instance.upgrade(request) ? undefined : new Response("WebSocket required", { status: 400 });
      }
      if (path === "/api/daemon/register") { registrations++; return Response.json({ daemonId: "fake-daemon", runtimes: [], daemonToken: "weft_daemon_fake" }); }
      if (path === "/api/daemon/stop") { stopRequests++; return Response.json({ ok: true }); }
      if (path === "/api/daemon/runs/claim") return Response.json([]);
      return Response.json({ ok: true });
    },
    websocket: { open() {}, message() {}, close() {} },
  });
  const configDir = join(configHome, "weft"); await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, "config.json"), JSON.stringify({ token: "fake-daemon-token", apiUrl: `http://127.0.0.1:${server.port}` }));
  const oldEntry = process.argv[1];
  let daemonPid: number | undefined;
  try {
    process.argv[1] = join(import.meta.dir, "../src/index.ts");
    const record = await startDaemonBackground({ env: { XDG_CONFIG_HOME: configHome, PATH: "" }, stdout: () => {} });
    daemonPid = record.pid;
    expect((await daemonStatus({ env: { XDG_CONFIG_HOME: configHome } })).running).toBe(true);
    const deadline = Date.now() + 20_000;
    while (registrations === 0 && Date.now() < deadline) await Bun.sleep(20);
    expect(registrations).toBeGreaterThan(0);
    const handshakeDeadline = Date.now() + 5_000;
    while (!websocketTarget && Date.now() < handshakeDeadline) await Bun.sleep(20);
    expect(new URL(websocketTarget).search).toBe("");
    expect(websocketAuthorization).toBe("Bearer weft_daemon_fake");
    await stopDaemon({ env: { XDG_CONFIG_HOME: configHome }, stdout: () => {} });
    daemonPid = undefined;
    expect(stopRequests).toBe(1);
    expect((await daemonStatus({ env: { XDG_CONFIG_HOME: configHome } })).running).toBe(false);
  } finally {
    process.argv[1] = oldEntry!;
    if (daemonPid) { try { process.kill(daemonPid, "SIGKILL"); } catch {} }
    server.stop(true);
  }
}, 30_000);

test("daemon startup does not open a WebSocket when shutdown arrives during registration", async () => {
  const configHome = await isolatedConfig();
  const controller = new AbortController();
  let registrationStarted!: () => void;
  const started = new Promise<void>((resolve) => { registrationStarted = resolve; });
  let finishRegistration!: () => void;
  const registrationResponse = new Promise<void>((resolve) => { finishRegistration = resolve; });
  let socketCreations = 0;
  const daemon = startDaemon({
    env: { XDG_CONFIG_HOME: configHome, WEFT_TOKEN: "weft_cli_test", WEFT_API_URL: "https://weft.example", PATH: "" },
    fetch: async (input) => {
      if (String(input).endsWith("/api/daemon/register")) {
        registrationStarted();
        await registrationResponse;
        return Response.json({ daemonId: "daemon-id", runtimes: [], daemonToken: "weft_daemon_test" });
      }
      return Response.json({ ok: true });
    },
    webSocket: () => { socketCreations++; throw new Error("unexpected WebSocket"); },
    signal: controller.signal,
  });

  await started;
  controller.abort();
  finishRegistration();
  await daemon;

  expect(socketCreations).toBe(0);
  await expect(readFile(join(configHome, "weft", "daemon-credential.json"), "utf8")).rejects.toThrow();
});

test("daemon start refuses a saved credential for a different explicit server before spawning or sending it", async () => {
  const configHome = await isolatedConfig();
  const directory = join(configHome, "weft"); await mkdir(directory, { recursive: true });
  const credential = "weft_saved_server_a_secret";
  await writeFile(join(directory, "config.json"), JSON.stringify({ token: credential, apiUrl: "https://server-a.example" }));
  const env = { XDG_CONFIG_HOME: configHome, WEFT_API_URL: "https://server-b.example", PATH: "" };
  let requests = 0;
  let spawned = false;
  const fetcher = async () => { requests++; return Response.json({}); };
  await expect(startDaemon({ env, fetch: fetcher })).rejects.toThrow("Your saved Weft sign-in is for https://server-a.example, but this command targets https://server-b.example");
  const errors: string[] = [];
  const code = await main(["bun", "weft", "--api-url", "https://server-b.example", "daemon", "start"], {
    env: { XDG_CONFIG_HOME: configHome, PATH: "" }, stdout: () => {}, stderr: (text) => errors.push(text), fetch: fetcher,
    backgroundSpawn: () => { spawned = true; return { pid: process.pid, unref() {} }; },
  });
  expect(code).toBe(1);
  expect(errors.join("")).toContain("Your saved Weft sign-in is for https://server-a.example");
  expect(errors.join("")).not.toContain(credential);
  expect(requests).toBe(0);
  expect(spawned).toBe(false);
});

test("global api-url reaches the background Daemon child and its status record", async () => {
  const configHome = await isolatedConfig();
  const directory = join(configHome, "weft"); await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "config.json"), JSON.stringify({ token: "server-a-token", apiUrl: "https://server-a.example" }));
  let childEnv: Record<string, string | undefined> | undefined;
  const output: string[] = [];
  const code = await main(["bun", "weft", "--api-url", "https://server-b.example", "daemon", "start"], {
    env: { XDG_CONFIG_HOME: configHome, WEFT_TOKEN: "server-b-token", PATH: "" }, stdout: (text) => output.push(text), stderr: () => {},
    fetch: async () => Response.json({ version: "0.0.0" }),
    backgroundSpawn: (_argv, options) => { childEnv = options?.env; return { pid: process.pid, unref() {} }; },
  });
  expect(code).toBe(0);
  expect(childEnv?.WEFT_API_URL).toBe("https://server-b.example");
  expect((JSON.parse(await readFile(join(directory, "daemon.json"), "utf8")) as { apiUrl: string }).apiUrl).toBe("https://server-b.example");
  expect(output.join("")).not.toContain("server-b-token");
});

test("Claude and Codex adapters build non-interactive commands and extract streamed final output", () => {
  expect(agentCliAdapters.claude.command({ model: "sonnet", prompt: "do it" })).toContain("bypassPermissions");
  expect(agentCliAdapters.claude.final('{"type":"result","result":"done"}')).toBe("done");
  expect(agentCliAdapters.codex.command({ model: null, prompt: "do it" })).toContain("--dangerously-bypass-approvals-and-sandbox");
  expect(agentCliAdapters.codex.final('{"type":"item.completed","item":{"type":"agent_message","text":"done"}}')).toBe("done");
});

test("Run child environment includes its allowlisted host and provider variables only", () => {
  const allowlisted = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TERM", "TMPDIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GIT_ASKPASS", "SSH_AUTH_SOCK"];
  const hostEnv = Object.fromEntries([...allowlisted.map((key) => [key, `host-${key}`]), ["WEFT_TOKEN", "daemon-token"], ["DATABASE_URL", "postgres://secret"], ["OTHER_TOKEN", "unlisted-token"], ["APP_SECRET", "unlisted-secret"]]);
  const child = childEnvironment({ runId: "run", runtimeId: "rt", agentCli: "claude", instructions: "", request: "", model: null, token: "run-token", workspaceId: "ws" }, "https://weft.example", hostEnv);
  expect(Object.keys(child).sort()).toEqual([...allowlisted, "WEFT_API_URL", "WEFT_COMMENT_ID", "WEFT_PROJECT_ID", "WEFT_RUN_ID", "WEFT_TOKEN", "WEFT_TRIGGER_ID", "WEFT_WORKSPACE_ID", "WEFT_WORK_ITEM_DISPLAY_ID", "WEFT_WORK_ITEM_ID"].sort());
  expect(child).toMatchObject({ HOME: "host-HOME", PATH: "host-PATH", ANTHROPIC_API_KEY: "host-ANTHROPIC_API_KEY", WEFT_TOKEN: "run-token", WEFT_API_URL: "https://weft.example" });
  expect(child).not.toHaveProperty("DATABASE_URL");
  expect(child).not.toHaveProperty("OTHER_TOKEN");
  expect(child).not.toHaveProperty("APP_SECRET");
});

test("Run child environment never carries the Daemon credential or any WEFT_DAEMON_* variable", () => {
  const hostEnv = { PATH: "/usr/bin", HOME: "/home/dev", WEFT_DAEMON_CHILD: "1", WEFT_DAEMON_TOKEN: "weft_daemon_secret", WEFT_TOKEN: "weft_cli_personal", XDG_CONFIG_HOME: "/home/dev/.config" };
  const child = childEnvironment({ runId: "run", runtimeId: "rt", agentCli: "claude", instructions: "", request: "", model: null, token: "weft_run_child", workspaceId: "ws" }, "https://weft.example", hostEnv);
  expect(Object.keys(child).filter((key) => key.startsWith("WEFT_DAEMON"))).toEqual([]);
  expect(Object.values(child)).not.toContain("weft_daemon_secret");
  expect(Object.values(child)).not.toContain("weft_cli_personal");
  expect(child.WEFT_TOKEN).toBe("weft_run_child");
});

test("Runtime environment overrides inherited provider credentials but cannot override platform variables", () => {
  const host = { PATH: "/host/bin", HOME: "/host", ANTHROPIC_API_KEY: "host-key", WEFT_TOKEN: "host-token" };
  const child = childEnvironment({ runId: "run", runtimeId: "rt", agentCli: "claude", instructions: "", request: "", model: null, token: "run-token", workspaceId: "ws", environment: { ANTHROPIC_API_KEY: "selected-key", CLAUDE_CONFIG_DIR: "/selected", WEFT_TOKEN: "bad", PATH: "/bad" } }, "https://weft.example", host);
  expect(child.ANTHROPIC_API_KEY).toBe("selected-key");
  expect(child.CLAUDE_CONFIG_DIR).toBe("/selected");
  expect(child.PATH).toBe("/host/bin");
  expect(child.WEFT_TOKEN).toBe("run-token");
});

test("selecting a Claude config suppresses an inherited API key unless the Agent explicitly configures one", () => {
  const host = { PATH: "/host/bin", HOME: "/host", ANTHROPIC_API_KEY: "host-key", WEFT_TOKEN: "host-token" };
  const base = { runId: "run", runtimeId: "rt", agentCli: "claude" as const, instructions: "", request: "", model: null, token: "run-token", workspaceId: "ws" };
  const selectedAccount = childEnvironment({ ...base, environment: { CLAUDE_CONFIG_DIR: "/selected" } }, "https://weft.example", host);
  expect(selectedAccount.CLAUDE_CONFIG_DIR).toBe("/selected");
  expect(selectedAccount).not.toHaveProperty("ANTHROPIC_API_KEY");

  const explicitKey = childEnvironment({ ...base, environment: { CLAUDE_CONFIG_DIR: "/selected", ANTHROPIC_API_KEY: "agent-key" } }, "https://weft.example", host);
  expect(explicitKey.ANTHROPIC_API_KEY).toBe("agent-key");

  const emptyKey = childEnvironment({ ...base, environment: { CLAUDE_CONFIG_DIR: "/selected", ANTHROPIC_API_KEY: "  " } }, "https://weft.example", host);
  expect(emptyKey).not.toHaveProperty("ANTHROPIC_API_KEY");

  const legacy = childEnvironment(base, "https://weft.example", host);
  expect(legacy.ANTHROPIC_API_KEY).toBe("host-key");

  const codex = childEnvironment({ ...base, agentCli: "codex", environment: { CLAUDE_CONFIG_DIR: "/selected" } }, "https://weft.example", host);
  expect(codex.ANTHROPIC_API_KEY).toBe("host-key");
});

test("Runtime environment values are redacted from CLI output before it is saved", () => {
  expect(redactRuntimeEnvironment('{"message":"selected-api-key","other":"safe"}', { ANTHROPIC_API_KEY: "selected-api-key" })).toBe('{"message":"[REDACTED]","other":"safe"}');
  expect(redactRuntimeEnvironment('{"message":"selected\\\"key"}', { ANTHROPIC_API_KEY: 'selected"key' })).toBe('{"message":"[REDACTED]"}');
  expect(redactRuntimeEnvironment("inherited-key", undefined, { ANTHROPIC_API_KEY: "inherited-key" })).toBe("[REDACTED]");
  expect(redactRuntimeEnvironment("openai-key run-token", undefined, { OPENAI_API_KEY: "openai-key", WEFT_TOKEN: "run-token" })).toBe("[REDACTED] [REDACTED]");
});

test("stream output redaction catches a JSON-escaped configured secret split across chunks", async () => {
  const secret = 'quoted"api\\key';
  const encoded = JSON.stringify({ message: secret });
  const chunks = [encoded.slice(0, 18), encoded.slice(18, 27), encoded.slice(27) + "\n"];
  const stream = new ReadableStream<Uint8Array>({ start(controller) { for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk)); controller.close(); } });
  const lines: string[] = [];
  await consumeRedactedOutput(stream, { ANTHROPIC_API_KEY: secret }, {}, async (line) => { lines.push(line); });
  expect(lines).toEqual(['{"message":"[REDACTED]"}']);
});

test("weft daemon start says to run weft login when the CLI token is missing", async () => {
  const configHome = await mkdtemp(join(tmpdir(), "weft-no-token-")); scratch.push(configHome);
  await expect(startDaemonBackground({ env: { XDG_CONFIG_HOME: configHome, PATH: Bun.env.PATH }, stdout: () => {} })).rejects.toThrow("Run `weft login`");
});

test("daemon detects Claude and Codex on the injected PATH, registers them, and heartbeats", async () => {
  const path = await mkdtemp(join(tmpdir(), "weft-path-")); scratch.push(path);
  const configHome = await mkdtemp(join(tmpdir(), "weft-config-")); scratch.push(configHome);
  await mkdir(join(configHome, "weft"), { recursive: true });
  await writeFile(join(configHome, "weft/config.json"), JSON.stringify({ token: "weft_cli", apiUrl: "https://weft.example" }));
  await Promise.all(["claude", "codex"].map(async (name) => { const file = join(path, name); await writeFile(file, "#!/bin/sh\nexit 0\n"); await chmod(file, 0o755); }));
  const controller = new AbortController();
  let registration: unknown;
  const frames: string[] = [];
  const observed = { advertisedCapabilities: null as string | null };
  class FakeSocket extends EventTarget {
    readyState = 0;
    constructor() { super(); setTimeout(() => { this.readyState = 1; this.dispatchEvent(new Event("open")); }, 0); }
    send(frame: string) { frames.push(frame); controller.abort(); }
    close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
  }
  await startDaemon({
    env: { XDG_CONFIG_HOME: configHome, PATH: path, WEFT_HOSTNAME: "devbox" },
    fetch: async (input, init) => { expect(new URL(String(input)).origin).toBe("https://weft.example"); expect(new Headers(init?.headers).get("authorization")).toBe("Bearer weft_cli"); if (String(input).endsWith("/api/daemon/register")) { registration = JSON.parse(String(init?.body)); observed.advertisedCapabilities = new Headers(init?.headers).get("x-weft-capabilities"); } return Response.json({ daemonId: "daemon-id", runtimes: [], daemonToken: "weft_daemon_test" }); },
    webSocket: (url, options) => {
      const target = new URL(url);
      expect(target.origin).toBe("wss://weft.example");
      expect(target.pathname).toBe("/api/daemon");
      expect(target.search).toBe("");
      expect(new Headers(options?.headers).get("authorization")).toBe("Bearer weft_daemon_test");
      return new FakeSocket() as unknown as WebSocket;
    },
    signal: controller.signal, heartbeatMs: 5,
  });
  expect(registration).toMatchObject({ hostname: "devbox", version: "1.0.0", agentClis: ["claude", "codex"], rotate: true });
  expect(registration).not.toHaveProperty("capabilities");
  expect(observed.advertisedCapabilities).toBe("runtime_environment,runtime_sandbox");
  // The Daemon credential lives in its own 0600 file in the 0700 Daemon directory, never in the CLI config.
  const credentialFile = join(configHome, "weft", "daemon-credential.json");
  expect(JSON.parse(await readFile(credentialFile, "utf8"))).toEqual({ token: "weft_daemon_test" });
  expect((await stat(credentialFile)).mode & 0o777).toBe(0o600);
  expect((await stat(join(configHome, "weft"))).mode & 0o777).toBe(0o700);
  expect(await readFile(join(configHome, "weft/config.json"), "utf8")).not.toContain("weft_daemon_test");
  expect(JSON.parse(frames[0]!)).toMatchObject({ type: "heartbeat", daemonId: "daemon-id" });
});

test("a Daemon told by a heartbeat acknowledgement that a Runtime is gone drops its record of it, keeps the other Runtime, and keeps running", async () => {
  const path = await mkdtemp(join(tmpdir(), "weft-gone-path-")); scratch.push(path);
  const configHome = await mkdtemp(join(tmpdir(), "weft-gone-config-")); scratch.push(configHome);
  await mkdir(join(configHome, "weft"), { recursive: true });
  await writeFile(join(configHome, "weft/config.json"), JSON.stringify({ token: "weft_cli", apiUrl: "https://weft.example" }));
  await Promise.all(["claude", "codex"].map(async (name) => { const file = join(path, name); await writeFile(file, "#!/bin/sh\nexit 0\n"); await chmod(file, 0o755); }));
  const controller = new AbortController();
  const heartbeats: Array<{ runtimeIds: string[] }> = [];
  class GoneSocket extends EventTarget {
    readyState = 0;
    constructor() { super(); setTimeout(() => { this.readyState = 1; this.dispatchEvent(new Event("open")); }, 0); }
    send(frame: string) {
      const message = JSON.parse(frame) as { type: string; runtimeIds?: string[] };
      if (message.type !== "heartbeat") return;
      heartbeats.push({ runtimeIds: message.runtimeIds ?? [] });
      // The first heartbeat is answered: the codex Runtime was deleted on the server. The Daemon must stop naming it.
      if (heartbeats.length === 1) this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "heartbeat_ack", at: new Date().toISOString(), goneRuntimeIds: ["codex-runtime"] }) }));
      // Keep heartbeating for a few more frames, so the Daemon is seen to keep running after the acknowledgement.
      if (heartbeats.length === 4) controller.abort();
    }
    close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
  }
  await startDaemon({
    env: { XDG_CONFIG_HOME: configHome, PATH: path, WEFT_HOSTNAME: "devbox" },
    fetch: async (input) => {
      if (String(input).endsWith("/api/daemon/register")) return Response.json({ daemonId: "daemon-id", runtimes: [{ id: "claude-runtime", agentCli: "claude" }, { id: "codex-runtime", agentCli: "codex" }], daemonToken: "weft_daemon_test" });
      return Response.json([]);
    },
    webSocket: () => new GoneSocket() as unknown as WebSocket,
    signal: controller.signal, heartbeatMs: 5, reprobeMs: 60_000, reregisterMs: 60_000, safetyPollMs: 60_000,
  });
  expect(heartbeats[0]!.runtimeIds.sort()).toEqual(["claude-runtime", "codex-runtime"]);
  expect(heartbeats.length).toBeGreaterThanOrEqual(4);
  for (const frame of heartbeats.slice(1)) expect(frame.runtimeIds).toEqual(["claude-runtime"]);
}, 30_000);

test("daemon reconnects with exponential backoff after dropped WebSockets", async () => {
  const controller = new AbortController();
  const waits: number[] = [];
  let registrations = 0;
  class DroppedSocket extends EventTarget {
    readyState = 0;
    constructor() { super(); setTimeout(() => { this.readyState = 1; this.dispatchEvent(new Event("open")); setTimeout(() => { this.readyState = 3; this.dispatchEvent(new Event("close")); }, 0); }, 0); }
    send() {}
    close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
  }
  await startDaemon({
    env: { XDG_CONFIG_HOME: await isolatedConfig(), WEFT_TOKEN: "weft_daemon", WEFT_API_URL: "https://weft.example", PATH: "" },
    fetch: async () => { registrations++; return Response.json({ daemonId: "daemon-id", runtimes: [], daemonToken: "weft_daemon_test" }); },
    webSocket: (url, options) => {
      expect(new URL(url).search).toBe("");
      expect(new Headers(options?.headers).get("authorization")).toBe("Bearer weft_daemon_test");
      return new DroppedSocket() as unknown as WebSocket;
    },
    signal: controller.signal,
    sleep: async (ms) => { waits.push(ms); if (waits.length === 2) controller.abort(); },
  });
  expect(registrations).toBe(2);
  expect(waits).toEqual([1_000, 2_000]);
});

test("the daemon claims work on its three-minute safety poll when no WebSocket work signal arrives", async () => {
  const controller = new AbortController();
  let claims = 0;
  class QuietSocket extends EventTarget {
    readyState = 0;
    constructor() { super(); setTimeout(() => { this.readyState = 1; this.dispatchEvent(new Event("open")); }, 0); }
    send() {}
    close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
  }
  await startDaemon({
    env: { XDG_CONFIG_HOME: await isolatedConfig(), WEFT_TOKEN: "weft_daemon", WEFT_API_URL: "https://weft.example", PATH: "" },
    fetch: async (input) => {
      if (String(input).endsWith("/api/daemon/runs/claim")) { claims++; controller.abort(); return Response.json([]); }
      return Response.json({ daemonId: "daemon-id", runtimes: [], daemonToken: "weft_daemon_test" });
    },
    webSocket: () => new QuietSocket() as unknown as WebSocket,
    signal: controller.signal, safetyPollMs: 5,
  });
  expect(claims).toBe(1);
});

test("the running Daemon re-probes PATH and registers a newly installed CLI", async () => {
  const path = await mkdtemp(join(tmpdir(), "weft-reprobe-")); scratch.push(path);
  const claude = join(path, "claude");
  await writeFile(claude, "#!/bin/sh\nexit 0\n"); await chmod(claude, 0o755);
  const controller = new AbortController();
  const registrations: unknown[] = [];
  class ConnectedSocket extends EventTarget {
    readyState = 0;
    constructor() { super(); setTimeout(() => { this.readyState = 1; this.dispatchEvent(new Event("open")); }, 0); }
    send() {}
    close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
  }
  await startDaemon({
    env: { XDG_CONFIG_HOME: await isolatedConfig(), WEFT_TOKEN: "weft_daemon", WEFT_API_URL: "https://weft.example", PATH: path },
    fetch: async (_input, init) => {
      const registration = JSON.parse(String(init?.body)) as { agentClis: string[] };
      registrations.push(registration.agentClis);
      if (registrations.length === 1) { await writeFile(join(path, "codex"), "#!/bin/sh\nexit 0\n"); await chmod(join(path, "codex"), 0o755); }
      else controller.abort();
      return Response.json({ daemonId: "daemon-id", runtimes: [], daemonToken: "weft_daemon_test" });
    },
    webSocket: () => new ConnectedSocket() as unknown as WebSocket,
    signal: controller.signal, reprobeMs: 10, heartbeatMs: 10_000,
  });
  expect(registrations).toEqual([["claude"], ["claude", "codex"]]);
});

test("a long Run streams every transcript message with a unique, increasing seq and the agent receives its work item", async () => {
  const path = await mkdtemp(join(tmpdir(), "weft-long-")); scratch.push(path);
  const seen = join(path, "seen.txt");
  await writeFile(join(path, "claude"), `#!/bin/sh\necho "$WEFT_WORK_ITEM_ID|$WEFT_WORK_ITEM_DISPLAY_ID|$WEFT_PROJECT_ID|$WEFT_WORKSPACE_ID|$2" > "${seen}"\ni=0\nwhile [ $i -lt 60 ]; do echo '{"type":"assistant","message":{"content":[{"type":"text","text":"step"}]}}'; i=$((i+1)); done\necho '{"type":"result","result":"all done"}'\n`);
  await chmod(join(path, "claude"), 0o755);
  const controller = new AbortController();
  const sequences: number[] = [];
  let finished: { finalOutput?: string } | undefined;
  let claimed = false;
  class WorkSocket extends EventTarget {
    readyState = 0;
    constructor() { super(); setTimeout(() => { this.readyState = 1; this.dispatchEvent(new Event("open")); this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "work_available" }) })); }, 0); }
    send() {}
    close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
  }
  const daemon = startDaemon({
    env: { XDG_CONFIG_HOME: await isolatedConfig(), WEFT_TOKEN: "weft_daemon", WEFT_API_URL: "https://weft.example", PATH: `${path}:${Bun.env.PATH}` },
    fetch: async (input, init) => {
      const url = String(input);
      if (url.endsWith("/api/daemon/runs/claim")) {
        if (claimed) return Response.json([]);
        claimed = true;
        return Response.json([{ runId: "run-1", runtimeId: "rt-1", agentCli: "claude", instructions: "Do it", request: "Request", model: null, token: "weft_run_x", workspaceId: "ws-1", projectId: "pr-1", workItemId: "wi-1", workItemDisplayId: "ALP-7", skills: [] }]);
      }
      if (url.endsWith("/api/daemon/runs/messages")) for (const message of JSON.parse(String(init?.body)).messages) sequences.push(message.seq);
      if (url.endsWith("/api/daemon/runs/finish")) { finished = JSON.parse(String(init?.body)); setTimeout(() => controller.abort(), 0); }
      return Response.json({ daemonId: "daemon-id", runtimes: [], ok: true, daemonToken: "weft_daemon_test" });
    },
    webSocket: () => new WorkSocket() as unknown as WebSocket,
    signal: controller.signal, safetyPollMs: 60_000,
  });
  await Promise.race([daemon, Bun.sleep(8_000)]);
  controller.abort();
  expect(finished?.finalOutput).toBe("all done");
  expect(sequences).toHaveLength(61);
  expect(sequences).toEqual(Array.from({ length: 61 }, (_, index) => index + 1));
  const [itemId, displayId, projectId, workspaceId, prompt] = (await readFile(seen, "utf8")).trim().split("|");
  expect([itemId, displayId, projectId, workspaceId]).toEqual(["wi-1", "ALP-7", "pr-1", "ws-1"]);
  expect(prompt).toContain("wi-1");
});

test("a blocked completion resumes the same CLI Session with a safe correction and retries the finish", async () => {
  const path = await mkdtemp(join(tmpdir(), "weft-secret-completion-retry-")); scratch.push(path);
  const argsPath = join(path, "args.txt");
  const countPath = join(path, "count.txt");
  const secret = "completion-secret-591";
  const encoded = Buffer.from(secret).toString("base64");
  await writeFile(join(path, "claude"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${argsPath}'\nif [ -f '${countPath}' ]; then n=$(cat '${countPath}'); else n=0; fi\nn=$((n + 1))\nprintf '%s' "$n" > '${countPath}'\necho '{"type":"system","subtype":"init","session_id":"session-secret-retry"}'\nif [ "$n" -eq 1 ]; then echo '{"type":"result","result":"encoded ${encoded}"}'; else echo '{"type":"result","result":"Corrected safely."}'; fi\n`);
  await chmod(join(path, "claude"), 0o755);
  const controller = new AbortController();
  const finishes: Array<{ status: string; finalOutput: string }> = [];
  let claimed = false;
  class WorkSocket extends EventTarget {
    readyState = 0;
    constructor() { super(); setTimeout(() => { this.readyState = 1; this.dispatchEvent(new Event("open")); this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "work_available" }) })); }, 0); }
    send() {}
    close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
  }
  await startDaemon({
    env: { XDG_CONFIG_HOME: await isolatedConfig(), WEFT_TOKEN: "weft_daemon", WEFT_API_URL: "https://weft.example", PATH: `${path}:${Bun.env.PATH}` },
    fetch: async (input, init) => {
      const url = String(input);
      if (url.endsWith("/api/daemon/runs/claim")) {
        if (claimed) return Response.json([]);
        claimed = true;
        return Response.json([{ runId: "run-secret-retry", runtimeId: "rt-1", agentCli: "claude", instructions: "Finish the work.", request: "Complete the requested change.", model: null, token: "weft_run_x", environment: { API_TOKEN: secret }, secretEnvironment: { API_TOKEN: secret }, workspaceId: "ws-1", projectId: "pr-1", workItemId: "wi-1", workItemDisplayId: "ALP-7" }]);
      }
      if (url.endsWith("/api/daemon/runs/finish")) {
        const body = JSON.parse(String(init?.body)) as { status: string; finalOutput: string };
        finishes.push(body);
        if (finishes.length === 1) return Response.json({ correctionRequired: true, message: "The Agent's final output was withheld because it contained a configured Runtime secret. Revise it without the secret; the secret value is intentionally omitted." });
        controller.abort();
      }
      return Response.json({ daemonId: "daemon-id", runtimes: [], ok: true, daemonToken: "weft_daemon_test" });
    },
    webSocket: () => new WorkSocket() as unknown as WebSocket,
    signal: controller.signal, safetyPollMs: 60_000,
  });
  const [first, second] = finishes;
  expect(first).toMatchObject({ status: "completed", finalOutput: `encoded ${encoded}` });
  expect(second).toMatchObject({ status: "completed", finalOutput: "Corrected safely." });
  expect(await readFile(countPath, "utf8")).toBe("2");
  const args = await readFile(argsPath, "utf8");
  expect(args).toContain("--resume session-secret-retry");
  expect(args).toContain("The Agent's final output was withheld");
  expect(args).not.toContain(secret);
});

test("the running Daemon registers again on a timer so workspaces joined later get Runtimes", async () => {
  const path = await mkdtemp(join(tmpdir(), "weft-rereg-")); scratch.push(path);
  await writeFile(join(path, "claude"), "#!/bin/sh\nexit 0\n"); await chmod(join(path, "claude"), 0o755);
  const controller = new AbortController();
  let registrations = 0;
  class ConnectedSocket extends EventTarget {
    readyState = 0;
    constructor() { super(); setTimeout(() => { this.readyState = 1; this.dispatchEvent(new Event("open")); }, 0); }
    send() {}
    close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
  }
  await startDaemon({
    env: { XDG_CONFIG_HOME: await isolatedConfig(), WEFT_TOKEN: "weft_daemon", WEFT_API_URL: "https://weft.example", PATH: path },
    fetch: async () => { registrations++; if (registrations >= 2) controller.abort(); return Response.json({ daemonId: "daemon-id", runtimes: [], daemonToken: "weft_daemon_test" }); },
    webSocket: () => new ConnectedSocket() as unknown as WebSocket,
    signal: controller.signal, reprobeMs: 10, reregisterMs: 20, heartbeatMs: 10_000,
  });
  expect(registrations).toBeGreaterThanOrEqual(2);
});

test("a failed transcript upload does not orphan the agent: the batch is retried and the Run still finishes", async () => {
  const path = await mkdtemp(join(tmpdir(), "weft-flush-")); scratch.push(path);
  await writeFile(join(path, "claude"), `#!/bin/sh\ni=0\nwhile [ $i -lt 30 ]; do echo '{"type":"assistant","message":{"content":[{"type":"text","text":"step"}]}}'; i=$((i+1)); done\necho '{"type":"result","result":"fine"}'\n`);
  await chmod(join(path, "claude"), 0o755);
  const controller = new AbortController();
  const sequences: number[] = [];
  let failures = 0; let finished = false; let claimed = false;
  class WorkSocket extends EventTarget {
    readyState = 0;
    constructor() { super(); setTimeout(() => { this.readyState = 1; this.dispatchEvent(new Event("open")); this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "work_available" }) })); }, 0); }
    send() {}
    close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
  }
  const daemon = startDaemon({
    env: { XDG_CONFIG_HOME: await isolatedConfig(), WEFT_TOKEN: "weft_daemon", WEFT_API_URL: "https://weft.example", PATH: `${path}:${Bun.env.PATH}` },
    fetch: async (input, init) => {
      const url = String(input);
      if (url.endsWith("/api/daemon/runs/claim")) { if (claimed) return Response.json([]); claimed = true; return Response.json([{ runId: "run-1", runtimeId: "rt-1", agentCli: "claude", instructions: "Do it", request: "R", model: null, token: "weft_run_x" }]); }
      if (url.endsWith("/api/daemon/runs/messages")) {
        if (failures++ === 0) return new Response("boom", { status: 500 });
        for (const message of JSON.parse(String(init?.body)).messages) sequences.push(message.seq);
      }
      if (url.endsWith("/api/daemon/runs/finish")) { finished = true; setTimeout(() => controller.abort(), 0); }
      return Response.json({ daemonId: "daemon-id", runtimes: [], ok: true, daemonToken: "weft_daemon_test" });
    },
    webSocket: () => new WorkSocket() as unknown as WebSocket,
    sleep: async () => {},
    signal: controller.signal, safetyPollMs: 60_000,
  });
  await Promise.race([daemon, Bun.sleep(8_000)]);
  controller.abort();
  expect(finished).toBe(true);
  expect(sequences).toEqual(Array.from({ length: 31 }, (_, index) => index + 1));
});

test("a 409 transcript flush still reports final usage and model to finish", async () => {
  const path = await mkdtemp(join(tmpdir(), "weft-flush-409-")); scratch.push(path);
  await writeFile(join(path, "claude"), `#!/bin/sh
for i in $(seq 1 30); do echo '{"type":"assistant","message":{"content":[{"type":"text","text":"step"}]}}'; done
echo '{"type":"system","subtype":"init","model":"claude-test"}'
echo '{"type":"result","result":"done","usage":{"input_tokens":7,"output_tokens":2,"cache_read_input_tokens":0,"cache_creation_input_tokens":0},"total_cost_usd":0.01}'
`);
  await chmod(join(path, "claude"), 0o755);
  const controller = new AbortController();
  let finish: { usage?: { inputTokens: number; outputTokens: number }; model?: string | null } | undefined;
  let claimed = false;
  class WorkSocket extends EventTarget {
    readyState = 0;
    constructor() { super(); setTimeout(() => { this.readyState = 1; this.dispatchEvent(new Event("open")); this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "work_available" }) })); }, 0); }
    send() {}
    close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
  }
  const daemon = startDaemon({
    env: { XDG_CONFIG_HOME: await isolatedConfig(), WEFT_TOKEN: "weft_daemon", WEFT_API_URL: "https://weft.example", PATH: `${path}:${Bun.env.PATH}` },
    fetch: async (input, init) => {
      const url = String(input);
      if (url.endsWith("/api/daemon/runs/claim")) { if (claimed) return Response.json([]); claimed = true; return Response.json([{ runId: "run-409", runtimeId: "rt-1", agentCli: "claude", instructions: "Do it", request: "R", model: null, token: "weft_run_x" }]); }
      if (url.endsWith("/api/daemon/runs/messages")) return new Response("inactive", { status: 409 });
      if (url.endsWith("/api/daemon/runs/finish")) { finish = JSON.parse(String(init?.body)); setTimeout(() => controller.abort(), 0); }
      return Response.json({ daemonId: "daemon-id", runtimes: [], ok: true, daemonToken: "weft_daemon_test" });
    },
    webSocket: () => new WorkSocket() as unknown as WebSocket,
    sleep: async () => {}, signal: controller.signal, safetyPollMs: 60_000,
  });
  await Promise.race([daemon, Bun.sleep(8_000)]);
  controller.abort();
  expect(finish).toMatchObject({ usage: { inputTokens: 7, outputTokens: 2 }, model: "claude-test" });
}, 12_000);

test("a CLI that cannot be spawned fails the Run instead of leaving it running", async () => {
  const path = await mkdtemp(join(tmpdir(), "weft-spawnfail-")); scratch.push(path);
  const controller = new AbortController();
  let finish: { status?: string; failureReason?: string } | undefined; let claimed = false;
  class WorkSocket extends EventTarget {
    readyState = 0;
    constructor() { super(); setTimeout(() => { this.readyState = 1; this.dispatchEvent(new Event("open")); this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "work_available" }) })); }, 0); }
    send() {}
    close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
  }
  const daemon = startDaemon({
    env: { XDG_CONFIG_HOME: await isolatedConfig(), WEFT_TOKEN: "weft_daemon", WEFT_API_URL: "https://weft.example", PATH: path },
    fetch: async (input, init) => {
      const url = String(input);
      if (url.endsWith("/api/daemon/runs/claim")) { if (claimed) return Response.json([]); claimed = true; return Response.json([{ runId: "run-1", runtimeId: "rt-1", agentCli: "claude", instructions: "Do it", request: "R", model: null, token: "weft_run_x" }]); }
      if (url.endsWith("/api/daemon/runs/finish")) { finish = JSON.parse(String(init?.body)); setTimeout(() => controller.abort(), 0); }
      return Response.json({ daemonId: "daemon-id", runtimes: [], ok: true, daemonToken: "weft_daemon_test" });
    },
    webSocket: () => new WorkSocket() as unknown as WebSocket,
    signal: controller.signal, safetyPollMs: 60_000,
  });
  await Promise.race([daemon, Bun.sleep(5_000)]);
  controller.abort();
  expect(finish).toMatchObject({ status: "failed", failureReason: "spawn_failed" });
});

test("a Runtime that enforces a sandbox makes the Daemon refuse a Full access Run without starting the CLI", async () => {
  const path = await mkdtemp(join(tmpdir(), "weft-enforce-")); scratch.push(path);
  const controller = new AbortController();
  let finish: { status?: string; failureReason?: string; finalOutput?: string } | undefined; let claimed = false; let started = false;
  class WorkSocket extends EventTarget {
    readyState = 0;
    constructor() { super(); setTimeout(() => { this.readyState = 1; this.dispatchEvent(new Event("open")); this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "work_available" }) })); }, 0); }
    send() {}
    close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
  }
  const daemon = startDaemon({
    env: { XDG_CONFIG_HOME: await isolatedConfig(), WEFT_TOKEN: "weft_daemon", WEFT_API_URL: "https://weft.example", PATH: path },
    fetch: async (input, init) => {
      const url = String(input);
      if (url.endsWith("/api/daemon/runs/claim")) { if (claimed) return Response.json([]); claimed = true; return Response.json([{ runId: "run-1", runtimeId: "rt-1", agentCli: "claude", instructions: "Do it", request: "R", model: null, token: "weft_run_x", sandbox: { id: "p", name: "Full access", mode: "full", filesystemAllowlist: [], networkAllowlist: [], enforce: true } }]); }
      if (url.endsWith("/api/daemon/runs/start")) started = true;
      if (url.endsWith("/api/daemon/runs/finish")) { finish = JSON.parse(String(init?.body)); setTimeout(() => controller.abort(), 0); }
      return Response.json({ daemonId: "daemon-id", runtimes: [], ok: true, daemonToken: "weft_daemon_test" });
    },
    webSocket: () => new WorkSocket() as unknown as WebSocket,
    signal: controller.signal, safetyPollMs: 60_000,
  });
  await Promise.race([daemon, Bun.sleep(5_000)]);
  controller.abort();
  expect(finish).toMatchObject({ status: "failed", failureReason: "sandbox_unavailable", finalOutput: expect.stringContaining("requires a sandbox") });
  expect(started).toBe(false);
});

test("adapters turn Claude and Codex streams into readable transcript text", () => {
  const claudeEvents = agentCliAdapters.claude.parse(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Looking at it" }, { type: "tool_use", name: "Bash", input: { command: "ls" } }] } }));
  expect(claudeEvents).toEqual([{ type: "thought", text: "Looking at it" }, { type: "thought", text: 'Tool Bash: {"command":"ls"}' }]);
  expect(agentCliAdapters.codex.parse(JSON.stringify({ type: "item.started", item: { type: "command_execution", command: "git status" } }))).toEqual([{ type: "thought", text: "Running git status" }]);
});

test("a cancel arriving on a new WebSocket after a reconnect still kills the Run and acknowledges it", async () => {
  const path = await mkdtemp(join(tmpdir(), "weft-reconnect-")); scratch.push(path);
  await writeFile(join(path, "claude"), "#!/bin/sh\nexec sleep 30\n"); await chmod(join(path, "claude"), 0o755);
  const controller = new AbortController();
  let claimed = false; let acked = false; let sockets = 0;
  class Socket extends EventTarget {
    readyState = 0;
    constructor(private readonly index: number) { super(); setTimeout(() => {
      this.readyState = 1; this.dispatchEvent(new Event("open"));
      if (index === 1) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "work_available" }) })); setTimeout(() => this.close(), 400); }
      else setTimeout(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "cancel", runId: "run-1" }) })), 100);
    }, 0); }
    send() {}
    close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
  }
  const daemon = startDaemon({
    env: { XDG_CONFIG_HOME: await isolatedConfig(), WEFT_TOKEN: "weft_daemon", WEFT_API_URL: "https://weft.example", PATH: `${path}:${Bun.env.PATH}` },
    fetch: async (input) => {
      const url = String(input);
      if (url.endsWith("/api/daemon/runs/claim")) { if (claimed) return Response.json([]); claimed = true; return Response.json([{ runId: "run-1", runtimeId: "rt-1", agentCli: "claude", instructions: "Do it", request: "R", model: null, token: "weft_run_x" }]); }
      if (url.endsWith("/api/daemon/runs/cancel-ack")) { acked = true; setTimeout(() => controller.abort(), 0); }
      return Response.json({ daemonId: "daemon-id", runtimes: [], ok: true, daemonToken: "weft_daemon_test" });
    },
    webSocket: () => new Socket(++sockets) as unknown as WebSocket,
    sleep: async () => {},
    signal: controller.signal, safetyPollMs: 60_000,
  });
  await Promise.race([daemon, Bun.sleep(8_000)]);
  controller.abort();
  expect(sockets).toBeGreaterThanOrEqual(2);
  expect(acked).toBe(true);
});

test("a revoked Daemon recovers pending Run cancellations after registration is refused", async () => {
  const path = await mkdtemp(join(tmpdir(), "weft-revoked-recovery-")); scratch.push(path);
  await writeFile(join(path, "claude"), "#!/bin/sh\nexec sleep 30\n"); await chmod(join(path, "claude"), 0o755);
  const configHome = await isolatedConfig();
  await mkdir(join(configHome, "weft"), { recursive: true });
  await writeFile(join(configHome, "weft", "daemon-credential.json"), JSON.stringify({ token: "weft_daemon_revoked" }));
  const controller = new AbortController();
  let registrations = 0; let recovered = false; let acked = false; let claimed = false;
  class Socket extends EventTarget {
    readyState = 0;
    constructor() { super(); setTimeout(() => {
      this.readyState = 1; this.dispatchEvent(new Event("open"));
      this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "work_available" }) }));
      setTimeout(() => this.close(), 350);
    }, 0); }
    send() {}
    close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
  }
  await startDaemon({
    env: { XDG_CONFIG_HOME: configHome, WEFT_TOKEN: "weft_personal", WEFT_API_URL: "https://weft.example", PATH: `${path}:${Bun.env.PATH}` },
    fetch: async (input) => {
      const url = String(input);
      if (url.endsWith("/api/daemon/register")) {
        registrations += 1;
        if (registrations > 1) return Response.json({ error: "revoked" }, { status: 401 });
        return Response.json({ daemonId: "daemon-id", runtimes: [] });
      }
      if (url.endsWith("/api/daemon/runs/claim")) {
        if (claimed) return Response.json([]);
        claimed = true;
        return Response.json([{ runId: "run-revoked", runtimeId: "rt-1", agentCli: "claude", instructions: "Do it", request: "R", model: null, token: "weft_run_x" }]);
      }
      if (url.endsWith("/api/daemon/runs/cancellations")) { recovered = true; return Response.json({ runIds: ["run-revoked"] }); }
      if (url.endsWith("/api/daemon/runs/cancel-ack")) { acked = true; setTimeout(() => controller.abort(), 0); }
      return Response.json({ ok: true });
    },
    webSocket: () => new Socket() as unknown as WebSocket,
    signal: controller.signal, sleep: async () => {}, safetyPollMs: 60_000,
  });
  expect(recovered).toBe(true);
  expect(acked).toBe(true);
});

test("the Daemon kills a Run's CLI when the server says the Run is no longer active, and when its own time limit passes", async () => {
  const path = await mkdtemp(join(tmpdir(), "weft-inactive-")); scratch.push(path);
  await writeFile(join(path, "claude"), `#!/bin/sh\nwhile true; do echo '{"type":"assistant","message":{"content":[{"type":"text","text":"tick"}]}}'; sleep 0.1; done\n`); await chmod(join(path, "claude"), 0o755);
  const run = async (mode: "inactive" | "timeout") => {
    const controller = new AbortController();
    let claimed = false; let finish: { failureReason?: string } | undefined; let ended = false;
    class WorkSocket extends EventTarget {
      readyState = 0;
      constructor() { super(); setTimeout(() => { this.readyState = 1; this.dispatchEvent(new Event("open")); this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "work_available" }) })); }, 0); }
      send() {}
      close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
    }
    const daemon = startDaemon({
      env: { XDG_CONFIG_HOME: await isolatedConfig(), WEFT_TOKEN: "weft_daemon", WEFT_API_URL: "https://weft.example", PATH: `${path}:${Bun.env.PATH}` },
      fetch: async (input, init) => {
        const url = String(input);
        if (url.endsWith("/api/daemon/runs/claim")) { if (claimed) return Response.json([]); claimed = true; return Response.json([{ runId: "run-1", runtimeId: "rt-1", agentCli: "claude", timeoutSeconds: mode === "timeout" ? 1 : 1800, instructions: "Do it", request: "R", model: null, token: "weft_run_x" }]); }
        if (url.endsWith("/api/daemon/runs/messages") && mode === "inactive") { ended = true; setTimeout(() => controller.abort(), 1_500); return new Response("not active", { status: 409 }); }
        if (url.endsWith("/api/daemon/runs/finish")) { finish = JSON.parse(String(init?.body)) as { failureReason?: string }; setTimeout(() => controller.abort(), 0); }
        return Response.json({ daemonId: "daemon-id", runtimes: [], ok: true, daemonToken: "weft_daemon_test" });
      },
      webSocket: () => new WorkSocket() as unknown as WebSocket,
      sleep: async () => {},
      signal: controller.signal, safetyPollMs: 60_000,
      stdout: () => {},
    });
    await Promise.race([daemon, Bun.sleep(6_000)]);
    controller.abort();
    return { ended, finish };
  };
  const inactive = await run("inactive");
  expect(inactive.ended).toBe(true);
  expect(inactive.finish).toBeUndefined();
  expect((await run("timeout")).finish).toMatchObject({ failureReason: "timeout" });
});

/** A socket that opens on the next tick and can be closed by the test with a close code and reason. */
function socketDouble(onOpen?: (socket: ScriptedSocket) => void) {
  return class ScriptedSocket extends EventTarget {
    readyState = 0;
    sent: string[] = [];
    constructor() {
      super();
      setTimeout(() => { this.readyState = 1; this.dispatchEvent(new Event("open")); onOpen?.(this); }, 0);
    }
    send(frame: string) { this.sent.push(frame); }
    close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
    closeWith(code: number, reason = "") { this.readyState = 3; this.dispatchEvent(new CloseEvent("close", { code, reason })); }
  };
}
type ScriptedSocket = EventTarget & { readyState: number; sent: string[]; send(frame: string): void; close(): void; closeWith(code: number, reason?: string): void };

test("a Daemon whose credential file holds a revoked token sends rotate:true after a 401 and recovers", async () => {
  const configHome = await isolatedConfig();
  await mkdir(join(configHome, "weft"), { recursive: true });
  await writeFile(join(configHome, "weft", "daemon-credential.json"), JSON.stringify({ token: "weft_daemon_revoked" }));
  const controller = new AbortController();
  const registrations: Array<{ rotate?: boolean }> = [];
  const claimedWith: string[] = [];
  const socketAuthorization: string[] = [];
  let socket: ScriptedSocket | undefined;
  const ScriptedSocket = socketDouble();
  await startDaemon({
    env: { XDG_CONFIG_HOME: configHome, WEFT_TOKEN: "weft_daemon", WEFT_API_URL: "https://weft.example", PATH: "" },
    fetch: async (input, init) => {
      const url = String(input);
      const bearer = new Headers(init?.headers).get("authorization");
      if (url.endsWith("/api/daemon/register")) {
        const body = JSON.parse(String(init?.body)) as { rotate?: boolean };
        registrations.push(body);
        return Response.json({ daemonId: "daemon-id", runtimes: [], ...(body.rotate ? { daemonToken: "weft_daemon_fresh" } : {}) });
      }
      if (url.endsWith("/api/daemon/runs/claim")) {
        claimedWith.push(bearer ?? "");
        if (bearer === "Bearer weft_daemon_revoked") {
          // The server refuses the revoked credential; the socket goes away a moment later, after the 401 is handled.
          const refusing = socket;
          setTimeout(() => refusing?.close(), 20);
          return Response.json({ error: "Daemon credential expired or invalid. Run `weft login` to sign in again." }, { status: 401 });
        }
        controller.abort();
        return Response.json([]);
      }
      return Response.json({ ok: true });
    },
    webSocket: (url, options) => {
      expect(new URL(url).search).toBe("");
      socketAuthorization.push(new Headers(options?.headers).get("authorization") ?? "");
      socket = new ScriptedSocket() as unknown as ScriptedSocket;
      return socket as unknown as WebSocket;
    },
    signal: controller.signal, sleep: async () => {}, safetyPollMs: 5, heartbeatMs: 60_000,
  });
  expect(registrations.map((body) => body.rotate)).toEqual([false, true]);
  // Polls during the refused socket's last moments may also use the revoked credential; the first and the last claim decide the test.
  expect(claimedWith[0]).toBe("Bearer weft_daemon_revoked");
  expect(claimedWith.at(-1)).toBe("Bearer weft_daemon_fresh");
  expect(socketAuthorization).toEqual(["Bearer weft_daemon_revoked", "Bearer weft_daemon_fresh"]);
  expect(JSON.parse(await readFile(join(configHome, "weft", "daemon-credential.json"), "utf8"))).toEqual({ token: "weft_daemon_fresh" });
});

test("a WebSocket closed with 1008 makes the next registration ask for a new credential and logs the code and reason", async () => {
  const configHome = await isolatedConfig();
  await mkdir(join(configHome, "weft"), { recursive: true });
  await writeFile(join(configHome, "weft", "daemon-credential.json"), JSON.stringify({ token: "weft_daemon_old" }));
  const controller = new AbortController();
  const registrations: Array<{ rotate?: boolean }> = [];
  const logs: string[] = [];
  let sockets = 0;
  const ScriptedSocket = socketDouble((socket) => {
    sockets++;
    if (sockets === 1) socket.closeWith(1008, "Daemon credential expired or invalid. Run `weft login` to sign in again.");
    else controller.abort();
  });
  await startDaemon({
    env: { XDG_CONFIG_HOME: configHome, WEFT_TOKEN: "weft_daemon", WEFT_API_URL: "https://weft.example", PATH: "" },
    fetch: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { rotate?: boolean };
      registrations.push(body);
      return Response.json({ daemonId: "daemon-id", runtimes: [], ...(body.rotate ? { daemonToken: "weft_daemon_fresh" } : {}) });
    },
    webSocket: () => new ScriptedSocket() as unknown as WebSocket,
    signal: controller.signal, sleep: async () => {}, heartbeatMs: 60_000, reprobeMs: 60_000,
    stdout: (text) => logs.push(text),
  });
  expect(registrations.map((body) => body.rotate)).toEqual([false, true]);
  expect(logs.join("")).toContain("1008");
  expect(logs.join("")).toContain("Run `weft login` to sign in again.");
});

test("a close with another code does not ask for a new credential, but a superseded credential does", async () => {
  const controller = new AbortController();
  const registrations: Array<{ rotate?: boolean }> = [];
  let sockets = 0;
  // The first socket is closed with 4001 (this Daemon's credential was replaced on the server); the file still holds that credential.
  const ScriptedSocket = socketDouble((socket) => {
    sockets++;
    if (sockets === 1) socket.closeWith(4001, "Daemon credential was replaced.");
    else controller.abort();
  });
  const configHome = await isolatedConfig();
  await mkdir(join(configHome, "weft"), { recursive: true });
  await writeFile(join(configHome, "weft", "daemon-credential.json"), JSON.stringify({ token: "weft_daemon_superseded" }));
  await startDaemon({
    env: { XDG_CONFIG_HOME: configHome, WEFT_TOKEN: "weft_daemon", WEFT_API_URL: "https://weft.example", PATH: "" },
    fetch: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { rotate?: boolean };
      registrations.push(body);
      return Response.json({ daemonId: "daemon-id", runtimes: [], ...(body.rotate ? { daemonToken: "weft_daemon_fresh" } : {}) });
    },
    webSocket: () => new ScriptedSocket() as unknown as WebSocket,
    signal: controller.signal, sleep: async () => {}, heartbeatMs: 60_000, reprobeMs: 60_000,
  });
  expect(registrations.map((body) => body.rotate)).toEqual([false, true]);
});

test("a Run's finish that gets a 401 re-reads the rotated credential and delivers its result", async () => {
  const path = await mkdtemp(join(tmpdir(), "weft-401-")); scratch.push(path);
  await writeFile(join(path, "claude"), `#!/bin/sh\necho '{"type":"result","result":"kept"}'\n`);
  await chmod(join(path, "claude"), 0o755);
  const configHome = await isolatedConfig();
  await mkdir(join(configHome, "weft"), { recursive: true });
  const credentialFile = join(configHome, "weft", "daemon-credential.json");
  await writeFile(credentialFile, JSON.stringify({ token: "weft_daemon_old" }));
  const controller = new AbortController();
  const finishes: string[] = [];
  let claimed = false;
  const ScriptedSocket = socketDouble((socket) => socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "work_available" }) })));
  await startDaemon({
    env: { XDG_CONFIG_HOME: configHome, WEFT_TOKEN: "weft_daemon", WEFT_API_URL: "https://weft.example", PATH: `${path}:${Bun.env.PATH}` },
    fetch: async (input, init) => {
      const url = String(input);
      const bearer = new Headers(init?.headers).get("authorization") ?? "";
      if (url.endsWith("/api/daemon/register")) return Response.json({ daemonId: "daemon-id", runtimes: [] });
      if (url.endsWith("/api/daemon/runs/claim")) {
        if (claimed) return Response.json([]);
        claimed = true;
        return Response.json([{ runId: "run-1", runtimeId: "rt-1", agentCli: "claude", instructions: "Do it", request: "R", model: null, token: "weft_run_x" }]);
      }
      if (url.endsWith("/api/daemon/runs/finish")) {
        finishes.push(bearer);
        if (finishes.length === 1) {
          // The credential was rotated on disk while the Run ran: the old one is refused.
          await writeFile(credentialFile, JSON.stringify({ token: "weft_daemon_new" }));
          return Response.json({ error: "Daemon credential expired or invalid." }, { status: 401 });
        }
        controller.abort();
        return Response.json({ ok: true });
      }
      return Response.json({ ok: true });
    },
    webSocket: () => new ScriptedSocket() as unknown as WebSocket,
    sleep: async () => {}, signal: controller.signal, safetyPollMs: 60_000, heartbeatMs: 60_000, reprobeMs: 60_000,
  });
  expect(finishes).toEqual(["Bearer weft_daemon_old", "Bearer weft_daemon_new"]);
});

test("a registration that returns 401 writes the weft login hint to the log and stderr and backs off instead of exiting", async () => {
  const configHome = await isolatedConfig();
  const controller = new AbortController();
  const logs: string[] = [];
  const errors: string[] = [];
  const waits: number[] = [];
  let registrations = 0;
  await startDaemon({
    env: { XDG_CONFIG_HOME: configHome, WEFT_TOKEN: "weft_expired", WEFT_API_URL: "https://weft.example", PATH: "" },
    fetch: async () => { registrations++; return Response.json({ error: "Personal API token expired or invalid. Run `weft login` to sign in again." }, { status: 401 }); },
    sleep: async (ms) => { waits.push(ms); if (waits.length === 3) controller.abort(); },
    signal: controller.signal,
    stdout: (text) => logs.push(text), stderr: (text) => errors.push(text),
  });
  expect(registrations).toBe(3);
  expect(logs.join("")).toContain("weft login");
  expect(errors.join("")).toContain("weft login");
  // Each retry waits longer, never more than 5 minutes.
  expect(waits[0]).toBeGreaterThanOrEqual(15_000);
  expect(waits[1]!).toBeGreaterThan(waits[0]!);
  expect(Math.max(...waits)).toBeLessThanOrEqual(5 * 60_000);
});

test("a running Daemon picks up a new weft login at its next registration attempt", async () => {
  const configHome = await isolatedConfig();
  await mkdir(join(configHome, "weft"), { recursive: true });
  const configFile = join(configHome, "weft", "config.json");
  await writeFile(configFile, JSON.stringify({ token: "weft_old", apiUrl: "https://weft.example" }));
  const controller = new AbortController();
  const tokensSeen: string[] = [];
  let sleeps = 0;
  await startDaemon({
    env: { XDG_CONFIG_HOME: configHome, WEFT_API_URL: "https://weft.example", PATH: "" },
    fetch: async (_input, init) => {
      tokensSeen.push(new Headers((init as RequestInit).headers).get("authorization") ?? "");
      return Response.json({ error: "Personal API token expired or invalid. Run `weft login` to sign in again." }, { status: 401 });
    },
    // The person runs `weft login` while the Daemon waits to retry: the file now holds a new token.
    sleep: async () => { sleeps++; if (sleeps === 1) await writeFile(configFile, JSON.stringify({ token: "weft_new", apiUrl: "https://weft.example" })); if (sleeps === 2) controller.abort(); },
    signal: controller.signal,
    stdout: () => {}, stderr: () => {},
  });
  expect(tokensSeen[0]).toBe("Bearer weft_old");
  expect(tokensSeen[1]).toBe("Bearer weft_new");
});
