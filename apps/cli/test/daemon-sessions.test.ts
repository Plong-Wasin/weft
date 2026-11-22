import { afterAll, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentCliAdapters } from "../src/agent-cli";
import { prepareSandbox } from "../src/sandbox";
import { SESSION_FOLDER_MAX_IDLE_MS, decideSession, executeRun, pruneSessionFolders } from "../src/daemon";

const scratch: string[] = [];
afterAll(async () => { await Promise.all(scratch.map((path) => rm(path, { recursive: true, force: true }))); });
const scratchDirectory = async (prefix: string) => { const path = await mkdtemp(join(tmpdir(), prefix)); scratch.push(path); return path; };

const FOLDER = "6f1c2a4e-9b3d-4c5e-8a7f-0123456789ab";
const OTHER_FOLDER = "7a2d3b5f-0c4e-4d6f-9b8a-1234567890bc";

/**
 * A fake `claude`: it logs its arguments and working folder, refuses an unknown `--resume` id the way a real CLI does, remembers
 * what it wrote in round one (`memory.txt` in the working folder) and reports the Session id `sess-1`.
 */
function fakeClaude(log: string) {
  return `#!/bin/sh
echo "ARGS $(printf '%s' "$*" | tr '\n' ' ')" >> "${log}"
echo "CWD $(pwd)" >> "${log}"
case " $* " in
  *" --resume sess-gone "*) echo "No conversation found with session ID: sess-gone" >&2; exit 1 ;;
esac
if [ "$CLAUDE_CONFIG_DIR" = "/invalid-account" ]; then
  echo "AUTH $CLAUDE_CONFIG_DIR \${ANTHROPIC_API_KEY:-missing}" >> "${log}"
  echo "Authentication failed for selected Claude account" >&2
  exit 1
fi
case " $* " in
  *" --resume sess-1 "*) remembered=$(cat memory.txt 2>/dev/null || echo missing) ;;
  *) remembered=none; echo "round one" > memory.txt ;;
esac
echo '{"type":"system","subtype":"init","session_id":"sess-1","model":"fake-model"}'
echo "{\\"type\\":\\"result\\",\\"result\\":\\"remembered: $remembered\\",\\"session_id\\":\\"sess-1\\"}"
`;
}

type Recorded = { path: string; body: any };

/** A claimed Run with the fields the Daemon reads; the session plan is what the server sent at claim. */
function claimedRun(session: { folder: string; resumeSessionId: string | null; reason: string } | null | undefined, runId = "run-1", environment?: Record<string, string>) {
  return { runId, runtimeId: "rt-1", agentCli: "claude" as const, instructions: "Do it", request: "Request", model: null, token: "weft_run_x", workspaceId: "ws-1", projectId: "pr-1", workItemId: "wi-1", workItemDisplayId: "ALP-7", skills: [], timeoutSeconds: 60, session, environment };
}

async function setup(retired: string[] = [], hostEnvironment: Record<string, string> = {}) {
  const bin = await scratchDirectory("weft-session-bin-");
  const sessionsRoot = await scratchDirectory("weft-sessions-");
  const log = join(bin, "claude.log");
  await writeFile(join(bin, "claude"), fakeClaude(log));
  await chmod(join(bin, "claude"), 0o755);
  const calls: Recorded[] = [];
  const call = async (path: string, body: any) => {
    calls.push({ path, body });
    if (path.endsWith("/api/daemon/session-folders/check")) return { retired };
    return { ok: true };
  };
  const environment = { env: { PATH: `${bin}:${Bun.env.PATH}`, HOME: bin, ...hostEnvironment }, sessionsRoot };
  const run = (session: Parameters<typeof claimedRun>[0], runId?: string, runtimeEnvironment?: Record<string, string>) => executeRun(environment, call, "https://weft.example", claimedRun(session, runId, runtimeEnvironment) as any, new Map());
  const argsOf = async () => (await readFile(log, "utf8")).split("\n").filter((line) => line.startsWith("ARGS"));
  return { sessionsRoot, log, call, calls, run, argsOf, folderPath: (folder: string) => join(sessionsRoot, folder) };
}

const finishOf = (calls: Recorded[]) => calls.filter((c) => c.path.endsWith("/api/daemon/runs/finish")).at(-1)!.body;
const startOf = (calls: Recorded[]) => calls.filter((c) => c.path.endsWith("/api/daemon/runs/start")).at(-1)!.body;

test("a second Run resumes the first Run's Session and works in the same folder, where round one's files are still there", async () => {
  const ctx = await setup();
  await ctx.run({ folder: FOLDER, resumeSessionId: null, reason: "first" }, "run-1");
  expect(finishOf(ctx.calls)).toMatchObject({ status: "completed", finalOutput: "remembered: none", session: { id: "sess-1", mode: "new", reason: "first" } });
  await ctx.run({ folder: FOLDER, resumeSessionId: "sess-1", reason: "resumed" }, "run-2");
  expect(startOf(ctx.calls)).toMatchObject({ runId: "run-2", session: { mode: "resumed", reason: "resumed" } });
  expect(finishOf(ctx.calls)).toMatchObject({ status: "completed", finalOutput: "remembered: round one", session: { id: "sess-1", mode: "resumed", reason: "resumed" } });
  const args = await ctx.argsOf();
  expect(args[1]).toContain("--resume sess-1");
  expect(args[0]).not.toContain("--resume");
  const cwds = (await readFile(ctx.log, "utf8")).split("\n").filter((line) => line.startsWith("CWD"));
  expect(cwds).toEqual([`CWD ${ctx.folderPath(FOLDER)}`, `CWD ${ctx.folderPath(FOLDER)}`]);
  expect((await readFile(join(ctx.folderPath(FOLDER), "memory.txt"), "utf8")).trim()).toBe("round one");
  expect((await stat(ctx.folderPath(FOLDER))).isDirectory()).toBe(true);
});

test("a Session whose folder is gone starts a new Session with the reason folder_missing and no resume argument", async () => {
  const ctx = await setup();
  await ctx.run({ folder: FOLDER, resumeSessionId: "sess-1", reason: "resumed" });
  expect(startOf(ctx.calls).session).toEqual({ mode: "new", reason: "folder_missing" });
  expect(finishOf(ctx.calls)).toMatchObject({ status: "completed", finalOutput: "remembered: none", session: { id: "sess-1", mode: "new", reason: "folder_missing" } });
  expect((await ctx.argsOf())[0]).not.toContain("--resume");
});

test("a CLI that rejects the resume does not fail the Run: it retries as a new Session in the same folder", async () => {
  const ctx = await setup();
  await mkdir(ctx.folderPath(FOLDER), { recursive: true });
  await ctx.run({ folder: FOLDER, resumeSessionId: "sess-gone", reason: "resumed" });
  const finish = finishOf(ctx.calls);
  expect(finish).toMatchObject({ status: "completed", finalOutput: "remembered: none", session: { id: "sess-1", mode: "new", reason: "cli_rejected_resume" } });
  const args = await ctx.argsOf();
  expect(args).toHaveLength(2);
  expect(args[0]).toContain("--resume sess-gone");
  expect(args[1]).not.toContain("--resume");
});

test("a configured Claude account that fails authentication fails the Run without falling back to the host account", async () => {
  const ctx = await setup([], { ANTHROPIC_API_KEY: "host-default-key" });
  await mkdir(ctx.folderPath(FOLDER), { recursive: true });
  await ctx.run({ folder: FOLDER, resumeSessionId: null, reason: "first" }, "run-invalid-account", { CLAUDE_CONFIG_DIR: "/invalid-account" });
  expect(finishOf(ctx.calls)).toMatchObject({ status: "failed", failureReason: "cli_exit" });
  expect(await readFile(ctx.log, "utf8")).toContain("AUTH /invalid-account missing");
  expect(await readFile(ctx.log, "utf8")).not.toContain("host-default-key");
});

test("a Run on the Weft server or without a work item never gets a folder or a Session", async () => {
  const ctx = await setup();
  await ctx.run(null);
  expect(startOf(ctx.calls)).not.toHaveProperty("session");
  expect(finishOf(ctx.calls)).toMatchObject({ status: "completed" });
  expect(finishOf(ctx.calls).session).toBeUndefined();
});

test("a folder the server retires is removed once the Run that used it has finished; the folder of a Run in use is never removed by the sweep", async () => {
  // A folder name of its own: the in-use set of the Daemon is shared by every test of this file, and tests run concurrently.
  const folder = crypto.randomUUID();
  const ctx = await setup([folder]);
  await ctx.run({ folder, resumeSessionId: null, reason: "first" });
  expect(ctx.calls.find((c) => c.path.endsWith("/session-folders/check"))?.body).toEqual({ folders: [folder] });
  await expect(stat(ctx.folderPath(folder))).rejects.toThrow();
});

test("a CLI without resume support starts a new Session every time, without an error", () => {
  const withoutResume = { ...agentCliAdapters.claude, resumable: false };
  expect(decideSession(withoutResume, { folder: FOLDER, resumeSessionId: "sess-1", reason: "resumed" }, true)).toEqual({ mode: "new", reason: "cli_without_resume", resume: null });
  expect(decideSession(agentCliAdapters.claude, { folder: FOLDER, resumeSessionId: "sess-1", reason: "resumed" }, true)).toEqual({ mode: "resumed", reason: "resumed", resume: "sess-1" });
  expect(decideSession(agentCliAdapters.claude, undefined, false)).toEqual({ mode: "new", reason: "no_work_item", resume: null });
});

test("the sweep removes a folder unused for seven days or retired by the server, keeps a folder in use, and leaves other names alone", async () => {
  const root = await scratchDirectory("weft-sweep-");
  const now = Date.parse("2026-11-16T12:00:00Z");
  const make = async (name: string, lastUsed: number) => {
    await mkdir(join(root, name), { recursive: true });
    await writeFile(join(root, name, ".weft-session.json"), JSON.stringify({ lastUsedAt: new Date(lastUsed).toISOString() }));
  };
  const old = "11111111-1111-4111-8111-111111111111";
  const recent = "22222222-2222-4222-8222-222222222222";
  const retired = "33333333-3333-4333-8333-333333333333";
  const activeOld = "44444444-4444-4444-8444-444444444444";
  await make(old, now - SESSION_FOLDER_MAX_IDLE_MS - 1000);
  await make(recent, now - 1000);
  await make(retired, now - 1000);
  await make(activeOld, now - SESSION_FOLDER_MAX_IDLE_MS - 1000);
  await mkdir(join(root, "not-a-folder-we-own"));
  const removed = await pruneSessionFolders(root, { now, active: new Set([activeOld]), retired: new Set([retired]) });
  expect(removed.sort()).toEqual([old, retired].sort());
  expect((await stat(join(root, recent))).isDirectory()).toBe(true);
  expect((await stat(join(root, activeOld))).isDirectory()).toBe(true);
  expect((await stat(join(root, "not-a-folder-we-own"))).isDirectory()).toBe(true);
});

test("adapters name the Session id of each CLI and resume it by its own flags", () => {
  const claude = agentCliAdapters.claude;
  expect(claude.sessionId('{"type":"system","subtype":"init","session_id":"abc-1"}')).toBe("abc-1");
  expect(claude.sessionId('{"type":"result","result":"done","session_id":"abc-1"}')).toBe("abc-1");
  expect(claude.sessionId('{"type":"assistant","message":{"content":[]}}')).toBeNull();
  expect(claude.command({ model: null, prompt: "P", resume: "abc-1" })).toEqual(expect.arrayContaining(["--resume", "abc-1"]));
  expect(claude.command({ model: null, prompt: "P" })).not.toContain("--resume");
  const codex = agentCliAdapters.codex;
  expect(codex.sessionId('{"type":"thread.started","thread_id":"thr-9"}')).toBe("thr-9");
  expect(codex.sessionId('{"type":"turn.completed"}')).toBeNull();
  expect(codex.command({ model: null, prompt: "P", resume: "thr-9" }).slice(0, 4)).toEqual(["codex", "exec", "resume", "thr-9"]);
  expect(codex.command({ model: null, prompt: "P" }).slice(0, 3)).toEqual(["codex", "exec", "--json"]);
});

test("sandbox settings are generated for every Run, and each Run may write only its own stable folder", async () => {
  const root = await scratchDirectory("weft-sandbox-sessions-");
  const runner = async (argv: string[]) => argv.includes("--version") ? { exitCode: 0, stdout: "0.0.83", stderr: "" } : { exitCode: 0, stdout: "", stderr: "" };
  const profile = { id: "p1", name: "Run folder", mode: "run-folder" as const, filesystemAllowlist: ["/opt/shared"], networkAllowlist: [], enforce: true };
  const folderA = join(root, FOLDER);
  const folderB = join(root, OTHER_FOLDER);
  const first = await prepareSandbox(profile, folderA, "https://weft.example", {}, runner);
  const second = await prepareSandbox(profile, folderB, "https://weft.example", {}, runner);
  const settingsA = JSON.parse(await readFile(first.command[2]!, "utf8"));
  const settingsB = JSON.parse(await readFile(second.command[2]!, "utf8"));
  expect(first.command[2]).not.toBe(second.command[2]);
  expect(settingsA.filesystem.allowWrite).toEqual([folderA]);
  expect(settingsA.filesystem.allowRead).toEqual([folderA, "/opt/shared"]);
  expect(settingsB.filesystem.allowWrite).toEqual([folderB]);
  expect(settingsB.filesystem.allowRead).not.toContain(folderA);
  await first.cleanup();
  await second.cleanup();
});
