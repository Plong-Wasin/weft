import { afterAll, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { daemonStatus, startDaemonBackground, stopDaemon } from "../src/daemon";
import { autostartStatus, disableAutostart, enableAutostart, probeAgentClis, readLogTail, recordServiceDaemon, restartDaemon, startDaemonForUser, type ProcessRunner } from "../src/daemon-ops";
import { checkForNewerCli, isNewerVersion } from "../src/version";
import { main } from "../src/program";

const scratch: string[] = [];
afterAll(async () => { await Promise.all(scratch.map((path) => rm(path, { recursive: true, force: true }))); });
const temp = async (prefix: string) => { const directory = await mkdtemp(join(tmpdir(), prefix)); scratch.push(directory); return directory; };
const waitFor = async (check: () => boolean, ms = 5_000) => { const deadline = Date.now() + ms; while (!check() && Date.now() < deadline) await Bun.sleep(20); return check(); };

/** A fake agent CLI on a private PATH folder: prints its version, or fails with the given message. */
async function fakeCli(folder: string, name: string, script: string) {
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, name), `#!/bin/sh\n${script}\n`);
  await chmod(join(folder, name), 0o755);
}

/** Records every command the autostart code asks the service manager to run. */
function recordingRunner(exitCode = 0, stderr = "") {
  const calls: string[][] = [];
  const run: ProcessRunner = async (argv) => { calls.push(argv); return { exitCode, stdout: "", stderr, timedOut: false }; };
  return { calls, run };
}

// ---------------------------------------------------------------- logs

test("logs shows the last lines of the log in text and JSON, and says when there is no log yet", async () => {
  const configHome = await temp("weft-logs-");
  const directory = join(configHome, "weft"); await mkdir(directory, { recursive: true });
  const logPath = join(directory, "daemon.log");
  await writeFile(logPath, Array.from({ length: 120 }, (_, index) => `line ${index + 1}`).join("\n") + "\n");
  const invoke = async (args: string[]) => { const out: string[] = []; const code = await main(["bun", "weft", "daemon", "logs", ...args], { env: { XDG_CONFIG_HOME: configHome }, stdout: (text) => out.push(text), stderr: () => {} }); return { code, text: out.join("") }; };
  const text = await invoke(["-n", "3"]);
  expect(text.code).toBe(0);
  expect(text.text).toBe("line 118\nline 119\nline 120\n");
  const json = JSON.parse((await invoke(["--lines", "2", "--json"])).text);
  expect(json).toEqual({ path: logPath, lines: ["line 119", "line 120"] });
  const defaults = (await invoke([])).text.split("\n").filter(Boolean);
  expect(defaults).toHaveLength(50);
  expect(defaults.at(-1)).toBe("line 120");
  await rm(logPath);
  expect((await invoke([])).text).toContain("No log yet at");
  expect(JSON.parse((await invoke(["--json"])).text)).toEqual({ path: logPath, lines: [] });
  expect((await invoke(["-n", "0"])).code).toBe(1);
});

test("a long log is read from its end without loading the whole file", async () => {
  const folder = await temp("weft-tail-");
  const path = join(folder, "daemon.log");
  const big = Array.from({ length: 40_000 }, (_, index) => `padding line number ${index} with text`).join("\n") + "\nthe final line\n";
  await writeFile(path, big);
  const lines = await readLogTail(path, 2);
  expect(lines).toEqual(["padding line number 39999 with text", "the final line"]);
});

test("logs --follow prints lines appended later, survives truncation, and stops when told", async () => {
  const configHome = await temp("weft-follow-");
  const directory = join(configHome, "weft"); await mkdir(directory, { recursive: true });
  const logPath = join(directory, "daemon.log");
  await writeFile(logPath, "first\n");
  const controller = new AbortController();
  const out: string[] = [];
  const finished = main(["bun", "weft", "daemon", "logs", "--follow"], { env: { XDG_CONFIG_HOME: configHome }, stdout: (text) => out.push(text), stderr: () => {}, signal: controller.signal });
  expect(await waitFor(() => out.join("").includes("first"))).toBe(true);
  await writeFile(logPath, "second\n", { flag: "a" });
  expect(await waitFor(() => out.join("").includes("second"))).toBe(true);
  await writeFile(logPath, "fresh start\n");
  expect(await waitFor(() => out.join("").includes("fresh start"))).toBe(true);
  controller.abort();
  expect(await finished).toBe(0);
  expect(out.join("")).toBe("first\nsecond\nfresh start\n");
});

test("logs --json cannot be combined with --follow", async () => {
  const errors: string[] = [];
  expect(await main(["bun", "weft", "daemon", "logs", "--json", "--follow"], { env: { XDG_CONFIG_HOME: await temp("weft-logs-flags-") }, stdout: () => {}, stderr: (text) => errors.push(text) })).toBe(1);
  expect(errors.join("")).toContain("--json cannot be combined with --follow");
});

// ---------------------------------------------------------------- probe

test("probe says which agent CLIs are ready and why the others are not, in text and JSON", async () => {
  const folder = await temp("weft-probe-");
  await fakeCli(join(folder, "good"), "claude", 'echo "claude 2.1.0 (Claude Code)"');
  await fakeCli(join(folder, "broken"), "codex", 'echo "codex: missing library libfoo" >&2; exit 3');
  const env = { PATH: `${join(folder, "good")}:${join(folder, "broken")}`, XDG_CONFIG_HOME: join(folder, "config") };
  const results = await probeAgentClis({ env });
  expect(results[0]).toMatchObject({ name: "claude", usable: true, version: "claude 2.1.0 (Claude Code)" });
  expect(results[1]).toMatchObject({ name: "codex", usable: false });
  expect(results[1]!.reason).toContain("codex --version");
  expect(results[1]!.reason).toContain("missing library libfoo");

  const out: string[] = [];
  expect(await main(["bun", "weft", "daemon", "probe"], { env, stdout: (text) => out.push(text), stderr: () => {} })).toBe(0);
  const text = out.join("");
  expect(text).toContain("claude: ready (claude 2.1.0 (Claude Code))");
  expect(text).toContain("codex: not ready. Found, but `codex --version` failed");
  expect(text).toContain("A usable CLI is registered");

  const jsonOut: string[] = [];
  await main(["bun", "weft", "daemon", "probe", "--json"], { env: { ...env, PATH: join(folder, "good") }, stdout: (text) => jsonOut.push(text), stderr: () => {} });
  const parsed = JSON.parse(jsonOut.join(""));
  expect(parsed.clis.map((cli: { name: string; usable: boolean }) => [cli.name, cli.usable])).toEqual([["claude", true], ["codex", false]]);
  expect(parsed.clis[1].reason).toContain("Not found on this computer's PATH");
});

test("probe reports a CLI that hangs as timed out instead of waiting forever", async () => {
  const folder = await temp("weft-probe-hang-");
  await fakeCli(folder, "claude", "while true; do :; done");
  const [result] = await probeAgentClis({ env: { PATH: folder }, timeoutMs: 300 });
  expect(result).toMatchObject({ name: "claude", usable: false });
  expect(result!.reason).toContain("did not answer within");
});

// ---------------------------------------------------------------- autostart

test("autostart is off by default and starting the Daemon does not touch the service manager", async () => {
  const configHome = await temp("weft-autostart-off-");
  const env = { XDG_CONFIG_HOME: configHome, HOME: configHome, WEFT_TOKEN: "daemon-test-token", WEFT_API_URL: "https://weft.example", PATH: "/usr/bin" };
  expect(await autostartStatus({ env, platform: "linux" })).toMatchObject({ enabled: false });
  const recorder = recordingRunner();
  let spawned: string[] | undefined;
  const record = await startDaemonForUser({ env, platform: "linux", run: recorder.run, stdout: () => {}, backgroundSpawn: (argv) => { spawned = argv; return { pid: process.pid, unref() {} }; } });
  expect(spawned?.slice(-2)).toEqual(["start", "--foreground"]);
  expect(recorder.calls).toEqual([]);
  expect(record.pid).toBe(process.pid);
  await rm(join(configHome, "weft", "daemon.json"));
});

test("enabling autostart writes a user systemd unit with no token, then disabling removes it", async () => {
  const configHome = await temp("weft-autostart-linux-");
  const env = { XDG_CONFIG_HOME: configHome, HOME: configHome, WEFT_TOKEN: "secret-personal-token", WEFT_HOSTNAME: "laptop-work", PATH: "/home/me/.local/bin:/usr/bin" };
  const recorder = recordingRunner();
  const message = await enableAutostart({ env, platform: "linux", run: recorder.run, execPath: "/usr/bin/bun", scriptPath: "/opt/weft/index.ts" });
  const unitPath = join(configHome, "systemd", "user", "weft-daemon.service");
  const unit = await readFile(unitPath, "utf8");
  expect(unit).toContain('ExecStart="/usr/bin/bun" "/opt/weft/index.ts" "daemon" "start" "--foreground"');
  expect(unit).toContain('Environment="PATH=/home/me/.local/bin:/usr/bin"');
  expect(unit).toContain('Environment="WEFT_HOSTNAME=laptop-work"');
  expect(unit).toContain("Restart=on-failure");
  expect(unit).toContain("WantedBy=default.target");
  expect(unit).not.toContain("secret-personal-token");
  expect((await stat(unitPath)).mode & 0o777).toBe(0o600);
  expect(recorder.calls).toEqual([["systemctl", "--user", "daemon-reload"], ["systemctl", "--user", "enable", "--now", "weft-daemon.service"]]);
  expect(message).toContain("Autostart is on");
  expect(await autostartStatus({ env, platform: "linux" })).toMatchObject({ enabled: true, file: unitPath });
  // Nothing in these commands asks for administrator rights.
  expect(recorder.calls.flat().some((part) => ["sudo", "--system", "/etc/systemd"].includes(part) || part.startsWith("/etc"))).toBe(false);

  const off = recordingRunner();
  expect(await disableAutostart({ env, platform: "linux", run: off.run })).toContain("Autostart is off");
  await expect(stat(unitPath)).rejects.toThrow();
  expect(off.calls[0]).toEqual(["systemctl", "--user", "disable", "--now", "weft-daemon.service"]);
  expect(await disableAutostart({ env, platform: "linux", run: off.run })).toContain("already off");
});

test("a service manager that refuses leaves no unit behind and says nothing changed", async () => {
  const configHome = await temp("weft-autostart-fail-");
  const env = { XDG_CONFIG_HOME: configHome, HOME: configHome, PATH: "/usr/bin" };
  const refusing = recordingRunner(1, "Failed to connect to bus: No medium found");
  await expect(enableAutostart({ env, platform: "linux", run: refusing.run, execPath: "/usr/bin/bun", scriptPath: "/opt/weft/index.ts" })).rejects.toThrow("Nothing was changed");
  expect(await autostartStatus({ env, platform: "linux" })).toMatchObject({ enabled: false });
});

test("autostart refuses to start a second Daemon while a background one runs", async () => {
  const configHome = await temp("weft-autostart-busy-");
  const directory = join(configHome, "weft"); await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "daemon.json"), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), apiUrl: "https://weft.example", agentClis: [], logPath: join(directory, "daemon.log") }));
  const env = { XDG_CONFIG_HOME: configHome, HOME: configHome, PATH: "/usr/bin" };
  await expect(enableAutostart({ env, platform: "linux", run: recordingRunner().run, execPath: "bun", scriptPath: "index.ts" })).rejects.toThrow("weft daemon stop");
});

test("autostart on macOS uses a per-user LaunchAgent and no administrator rights", async () => {
  const home = await temp("weft-autostart-mac-");
  const env = { HOME: home, XDG_CONFIG_HOME: join(home, ".config"), PATH: "/usr/local/bin:/usr/bin" };
  const recorder = recordingRunner();
  await enableAutostart({ env, platform: "darwin", run: recorder.run, uid: 501, execPath: "/usr/local/bin/bun", scriptPath: "/opt/weft/index.ts" });
  const plist = join(home, "Library", "LaunchAgents", "com.weft.daemon.plist");
  const text = await readFile(plist, "utf8");
  expect(text).toContain("<string>com.weft.daemon</string>");
  expect(text).toContain("<string>/opt/weft/index.ts</string>");
  expect(text).toContain("<key>RunAtLoad</key>");
  expect(text).toContain("<key>SuccessfulExit</key>");
  expect(recorder.calls.at(-1)).toEqual(["launchctl", "bootstrap", "gui/501", plist]);
  expect(recorder.calls.flat().some((part) => part === "sudo" || part.startsWith("/Library/LaunchDaemons"))).toBe(false);
  await disableAutostart({ env, platform: "darwin", run: recorder.run, uid: 501 });
  await expect(stat(plist)).rejects.toThrow();
  expect(recorder.calls.at(-1)).toEqual(["launchctl", "bootout", "gui/501/com.weft.daemon"]);
});

test("autostart says it is unavailable on other systems instead of guessing", async () => {
  await expect(enableAutostart({ env: { HOME: "/tmp" }, platform: "win32", run: recordingRunner().run })).rejects.toThrow("not available on this computer yet");
  expect(await autostartStatus({ env: { HOME: "/tmp" }, platform: "win32" })).toMatchObject({ enabled: false, platform: "unsupported" });
});

// ---------------------------------------------------------------- restart against a fake server

test("restart stops the running Daemon and starts it again, in text and JSON", async () => {
  const configHome = await mkdtemp(join(tmpdir(), "weft-restart-")); scratch.push(configHome);
  let registrations = 0;
  const server = Bun.serve({
    port: 0,
    fetch(request, instance) {
      const path = new URL(request.url).pathname;
      if (path === "/api/daemon") return instance.upgrade(request) ? undefined : new Response("WebSocket required", { status: 400 });
      if (path === "/api/daemon/register") { registrations++; return Response.json({ daemonId: "fake-daemon", runtimes: [], daemonToken: "weft_daemon_fake" }); }
      if (path === "/api/daemon/runs/claim") return Response.json([]);
      return Response.json({ ok: true });
    },
    websocket: { open() {}, message() {}, close() {} },
  });
  const configDir = join(configHome, "weft"); await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, "config.json"), JSON.stringify({ token: "fake-daemon-token", apiUrl: `http://127.0.0.1:${server.port}` }));
  const env = { XDG_CONFIG_HOME: configHome, PATH: "" };
  const oldEntry = process.argv[1];
  let livePid: number | undefined;
  try {
    process.argv[1] = join(import.meta.dir, "../src/index.ts");
    const first = await startDaemonBackground({ env, stdout: () => {} });
    livePid = first.pid;
    expect(await waitFor(() => registrations > 0, 20_000)).toBe(true);
    const out: string[] = [];
    expect(await main(["bun", "weft", "daemon", "restart", "--json"], { env, stdout: (text) => out.push(text), stderr: () => {} })).toBe(0);
    const result = JSON.parse(out.join(""));
    expect(result).toMatchObject({ previousPid: first.pid, managedBy: "background" });
    expect(result.pid).toBeGreaterThan(0);
    expect(result.pid).not.toBe(first.pid);
    livePid = result.pid;
    expect((await daemonStatus({ env })).running).toBe(true);
    expect(processExistsNow(first.pid)).toBe(false);

    const text: string[] = [];
    expect(await main(["bun", "weft", "daemon", "restart"], { env, stdout: (value) => text.push(value), stderr: () => {} })).toBe(0);
    expect(text.join("")).toContain(`Stopped process ${result.pid}. Daemon restarted (process `);
    expect(await waitFor(() => registrations > 1, 20_000)).toBe(true);
    livePid = (await daemonStatus({ env })).pid;
  } finally {
    process.argv[1] = oldEntry!;
    await stopDaemon({ env, stdout: () => {} }).catch(() => {});
    if (livePid) { try { process.kill(livePid, "SIGKILL"); } catch {} }
    server.stop(true);
  }
}, 30_000);

test("restart with no running Daemon just starts one", async () => {
  const configHome = await temp("weft-restart-cold-");
  const env = { XDG_CONFIG_HOME: configHome, WEFT_TOKEN: "daemon-test-token", WEFT_API_URL: "https://weft.example", PATH: "/usr/bin" };
  let spawns = 0;
  const result = await restartDaemon({ env, backgroundSpawn: () => { spawns++; return { pid: process.pid, unref() {} }; } });
  expect(result).toMatchObject({ previousPid: undefined, pid: process.pid, managedBy: "background" });
  expect(spawns).toBe(1);
  await rm(join(configHome, "weft", "daemon.json"));
}, 30_000);

function processExistsNow(pid: number) {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

// ---------------------------------------------------------------- version check

test("a newer CLI is reported with a plain notice, and nothing is installed", async () => {
  const calls: string[] = [];
  const fakeFetch = (latest: unknown) => async (input: string | URL | Request) => { calls.push(String(input)); return Response.json({ latest }); };
  const notice = await checkForNewerCli({ fetch: fakeFetch("1.2.0"), apiUrl: "https://weft.example/", current: "1.0.0" });
  expect(notice).toContain("A newer weft CLI is available: 1.2.0 (this one is 1.0.0)");
  expect(notice).toContain("Weft does not update itself");
  expect(calls).toEqual(["https://weft.example/api/cli/version"]);
  expect(await checkForNewerCli({ fetch: fakeFetch("1.0.0"), apiUrl: "https://weft.example", current: "1.0.0" })).toBeUndefined();
  expect(await checkForNewerCli({ fetch: fakeFetch("0.9.9"), apiUrl: "https://weft.example", current: "1.0.0" })).toBeUndefined();
  expect(await checkForNewerCli({ fetch: fakeFetch(null), apiUrl: "https://weft.example", current: "1.0.0" })).toBeUndefined();
  expect(await checkForNewerCli({ fetch: async () => { throw new Error("offline"); }, apiUrl: "https://weft.example", current: "1.0.0" })).toBeUndefined();
  expect(isNewerVersion("1.10.0", "1.9.9")).toBe(true);
  expect(isNewerVersion("1.9.0", "1.10.0")).toBe(false);
});

test("daemon status shows the newer-CLI notice from a fake server, and JSON stays plain", async () => {
  const server = Bun.serve({ port: 0, fetch: (request) => new URL(request.url).pathname === "/api/cli/version" ? Response.json({ latest: "9.0.0" }) : new Response("no", { status: 404 }) });
  const configHome = await temp("weft-status-version-");
  const env = { XDG_CONFIG_HOME: configHome, WEFT_API_URL: `http://127.0.0.1:${server.port}` };
  try {
    const out: string[] = [];
    await main(["bun", "weft", "daemon", "status"], { env, stdout: (text) => out.push(text), stderr: () => {} });
    expect(out.join("")).toContain("A newer weft CLI is available: 9.0.0");
    expect(out.join("")).toContain("Start at login: off");
    const json: string[] = [];
    await main(["bun", "weft", "daemon", "status", "--json"], { env, stdout: (text) => json.push(text), stderr: () => {} });
    expect(JSON.parse(json.join(""))).toMatchObject({ running: false, autostart: false });
  } finally { server.stop(true); }
});

test("the autostart service records its own process so status and stop find it, and refuses a second live Daemon", async () => {
  const configHome = await temp("weft-service-record-");
  const env = { XDG_CONFIG_HOME: configHome, PATH: "/usr/bin" };
  const release = await recordServiceDaemon({ env, apiUrl: "https://weft.example" });
  expect(await daemonStatus({ env })).toMatchObject({ running: true, pid: process.pid, server: "https://weft.example" });
  await release();
  expect((await daemonStatus({ env })).running).toBe(false);
  await mkdir(join(configHome, "weft"), { recursive: true });
  await writeFile(join(configHome, "weft", "daemon.json"), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), apiUrl: "https://weft.example", agentClis: [], logPath: "x" }));
  // A live other process is a second Daemon and is refused.
  const other = Bun.spawn(["sleep", "5"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  try {
    await writeFile(join(configHome, "weft", "daemon.json"), JSON.stringify({ pid: other.pid, startedAt: new Date().toISOString(), apiUrl: "https://weft.example", agentClis: [], logPath: "x" }));
    await expect(recordServiceDaemon({ env, apiUrl: "https://weft.example" })).rejects.toThrow(`process ${other.pid}`);
  } finally { other.kill(); await other.exited; }
});

// ---------------------------------------------------------------- secrets never reach the screen

const DAEMON_TOKEN = `weft_daemon_${"0123456789abcdef".repeat(4)}`;
const PERSONAL_TOKEN = `weft_${"fedcba9876543210".repeat(4)}`;
const RUN_TOKEN = `weft_run_${"a1b2c3d4e5f60718".repeat(4)}`;

test("logs never print a Daemon credential, Personal token or Run token, in text, JSON or follow", async () => {
  const configHome = await temp("weft-redact-");
  const directory = join(configHome, "weft"); await mkdir(directory, { recursive: true });
  const logPath = join(directory, "daemon.log");
  await writeFile(logPath, `registered with ${DAEMON_TOKEN}\nlogin used ${PERSONAL_TOKEN} and url ws://x/api/daemon?token=${DAEMON_TOKEN}\nrun ${RUN_TOKEN} started\nplain line\n`);
  const env = { XDG_CONFIG_HOME: configHome };
  const text: string[] = [];
  expect(await main(["bun", "weft", "daemon", "logs"], { env, stdout: (value) => text.push(value), stderr: () => {} })).toBe(0);
  const json: string[] = [];
  expect(await main(["bun", "weft", "daemon", "logs", "--json"], { env, stdout: (value) => json.push(value), stderr: () => {} })).toBe(0);
  for (const output of [text.join(""), json.join("")]) {
    expect(output).not.toContain(DAEMON_TOKEN);
    expect(output).not.toContain(PERSONAL_TOKEN);
    expect(output).not.toContain(RUN_TOKEN);
    expect(output).toContain("[redacted token]");
    expect(output).toContain("plain line");
  }
  // Follow: a token written in two pieces must still be hidden, and a line stays whole.
  const controller = new AbortController();
  const followed: string[] = [];
  const finished = main(["bun", "weft", "daemon", "logs", "--follow"], { env, stdout: (value) => followed.push(value), stderr: () => {} , signal: controller.signal });
  expect(await waitFor(() => followed.join("").includes("plain line"))).toBe(true);
  await writeFile(logPath, `split ${DAEMON_TOKEN.slice(0, 20)}`, { flag: "a" });
  await Bun.sleep(600);
  await writeFile(logPath, `${DAEMON_TOKEN.slice(20)} done\n`, { flag: "a" });
  expect(await waitFor(() => followed.join("").includes("done"))).toBe(true);
  controller.abort();
  await finished;
  const shown = followed.join("");
  expect(shown).not.toContain(DAEMON_TOKEN.slice(0, 20));
  expect(shown).not.toContain(DAEMON_TOKEN.slice(20));
  expect(shown).toContain("split [redacted token] done");
});

test("the autostart unit and LaunchAgent hold only the command and safe settings, never a token, and are owner-only", async () => {
  const home = await temp("weft-unit-secrets-");
  const env = { HOME: home, XDG_CONFIG_HOME: join(home, ".config"), WEFT_TOKEN: PERSONAL_TOKEN, WEFT_DAEMON_CREDENTIAL: DAEMON_TOKEN, WEFT_HOSTNAME: "laptop", PATH: "/usr/bin" };
  await mkdir(join(home, ".config", "weft"), { recursive: true });
  await writeFile(join(home, ".config", "weft", "daemon-credential.json"), JSON.stringify({ token: DAEMON_TOKEN }));
  await writeFile(join(home, ".config", "weft", "config.json"), JSON.stringify({ token: PERSONAL_TOKEN, apiUrl: "https://weft.example" }));
  const linux = recordingRunner();
  await enableAutostart({ env, platform: "linux", run: linux.run, uid: 501, execPath: "/usr/bin/bun", scriptPath: "/opt/weft/index.ts" });
  const unitPath = join(home, ".config", "systemd", "user", "weft-daemon.service");
  const unit = await readFile(unitPath, "utf8");
  expect(unit).not.toMatch(/weft_/);
  expect(unit).not.toContain(PERSONAL_TOKEN);
  expect(unit).not.toContain(DAEMON_TOKEN);
  expect(unit.split("\n").filter((line) => line.startsWith("ExecStart="))).toHaveLength(1);
  expect((await stat(unitPath)).mode & 0o777).toBe(0o600);
  await disableAutostart({ env, platform: "linux", run: linux.run, uid: 501 });
  await expect(stat(unitPath)).rejects.toThrow();

  const mac = recordingRunner();
  await enableAutostart({ env, platform: "darwin", run: mac.run, uid: 501, execPath: "/usr/local/bin/bun", scriptPath: "/opt/weft/index.ts" });
  const plist = join(home, "Library", "LaunchAgents", "com.weft.daemon.plist");
  const plistText = await readFile(plist, "utf8");
  expect(plistText).not.toMatch(/weft_/);
  expect((await stat(plist)).mode & 0o777).toBe(0o600);
  await disableAutostart({ env, platform: "darwin", run: mac.run, uid: 501 });
  await expect(stat(plist)).rejects.toThrow();
});

test("autostart 'on' and 'off' are accepted as shorter names for enable and disable", async () => {
  const { buildProgram } = await import("../src/program");
  const autostart = buildProgram({ env: {} }).commands.find((command) => command.name() === "daemon")!.commands.find((command) => command.name() === "autostart")!;
  const sub = (name: string) => autostart.commands.find((command) => command.name() === name)!;
  expect(sub("enable").aliases()).toContain("on");
  expect(sub("disable").aliases()).toContain("off");
});
