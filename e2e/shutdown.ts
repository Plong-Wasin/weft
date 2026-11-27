import type { ChildProcess } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";

export const flowOwnerKey = "WEFT_E2E_FLOW_OWNER";

class DeadlineError extends Error {}

/** Bound async teardown and discard the timer when the operation settles. */
export async function withDeadline<T>(operation: PromiseLike<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new DeadlineError(`${label} timed out after ${ms}ms`)), ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

type Child = { readonly exited: Promise<number>; kill(signal: "SIGTERM" | "SIGKILL"): void };

export async function stopProcess(child: Child, graceMs = 5_000) {
  child.kill("SIGTERM");
  try {
    await withDeadline(child.exited, graceMs, "child exit");
  } catch (error) {
    if (!(error instanceof DeadlineError)) throw error;
    child.kill("SIGKILL");
    await withDeadline(child.exited, graceMs, "forced child exit");
  }
}

type ProcessEntry = { parent: number; started: string };

/** Every live process with its parent. Zombies are already stopped, so they are left out. */
function processTable(): Map<number, ProcessEntry> {
  const table = new Map<number, ProcessEntry>();
  if (process.platform === "linux") {
    for (const entry of readdirSync("/proc").filter((name) => /^\d+$/.test(name))) {
      const stat = readProc(entry, "stat");
      // The command name in parentheses can hold spaces, so fields are counted after it.
      const fields = stat?.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (fields && fields[0] !== "Z") table.set(Number(entry), { parent: Number(fields[1]), started: fields[19]! });
    }
    return table;
  }
  const { stdout, exitCode } = Bun.spawnSync(["ps", "-A", "-o", "pid=,ppid=,stat="]);
  if (exitCode !== 0) throw new Error("could not list flow processes");
  for (const line of stdout.toString().trim().split("\n")) {
    const [pid, parent, state] = line.trim().split(/\s+/);
    if (state && !state.startsWith("Z")) table.set(Number(pid), { parent: Number(parent), started: "" });
  }
  return table;
}

function readProc(pid: string | number, file: "stat" | "environ"): string | undefined {
  try {
    return readFileSync(`/proc/${pid}/${file}`, "utf8");
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    // A process can exit during the walk, and other users' processes are private.
    if (!["ENOENT", "ESRCH", "EACCES", "EPERM"].includes(code ?? "")) throw error;
    return undefined;
  }
}

/** The inherited marker stays with a process that starts a session or is reparented. */
function markedProcesses(owner: string): number[] {
  const marker = `${flowOwnerKey}=${owner}`;
  if (process.platform === "linux") {
    return readdirSync("/proc").filter((entry) => /^\d+$/.test(entry) && readProc(entry, "environ")?.split("\0").includes(marker)).map(Number);
  }
  const { stdout, exitCode } = Bun.spawnSync(["ps", "-A", "-Eww", "-o", "pid=,stat=,command="]);
  if (exitCode !== 0) throw new Error("could not list flow processes");
  return stdout.toString().trim().split("\n").flatMap((line) => {
    const [pid, state, ...command] = line.trim().split(/\s+/);
    return state && !state.startsWith("Z") && command.includes(marker) ? [Number(pid)] : [];
  });
}

/**
 * Adds to `known` the marked processes and all their descendants, and drops the ones that exited.
 * Chromium overwrites its environment, so only its parent links show that it belongs to the flow.
 * A process stays known after its parent exits; the start time guards against a reused pid.
 */
function ownedProcesses(owner: string, known = new Map<number, string>()): number[] {
  const table = processTable();
  for (const [pid, started] of known) {
    if (table.get(pid)?.started !== started) known.delete(pid);
  }
  const add = (pid: number) => {
    const entry = table.get(pid);
    if (entry) known.set(pid, entry.started);
  };
  markedProcesses(owner).forEach(add);
  for (let size = -1; size !== known.size;) {
    size = known.size;
    for (const [pid, { parent }] of table) {
      if (known.has(parent)) add(pid);
    }
  }
  return [...known.keys()];
}

function signalProcess(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

/** Bound one flow and stop its owned processes before releasing the worker. */
export async function runWithTimeout(child: ChildProcess, file: string, timeoutMs: number, owner: string) {
  const exited = child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve(child.exitCode ?? 1)
    : new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code) => resolve(code ?? 1));
      });
  let exitCode: number;
  try {
    exitCode = await withDeadline(exited, timeoutMs, file);
  } catch (error) {
    if (!(error instanceof DeadlineError) || child.pid === undefined) throw error;
    try {
      await stopFlow(child, owner, exited);
    } catch (cleanupError) {
      throw new Error(`${error.message}; flow cleanup failed: ${cleanupError}`, { cause: error });
    }
    throw error;
  }
  if (ownedProcesses(owner).length) await stopFlow(child, owner, exited);
  return exitCode;
}

async function stopFlow(child: ChildProcess, owner: string, exited: Promise<number>) {
  const running = () => child.exitCode === null && child.signalCode === null;
  const known = new Map<number, string>();
  // Parent links go away when a parent exits, so the first walk starts at the flow before anything is signalled.
  const root = running() ? processTable().get(child.pid!) : undefined;
  if (root) known.set(child.pid!, root.started);
  const others = () => ownedProcesses(owner, known).filter((pid) => pid !== child.pid);
  const signal = (value: NodeJS.Signals) => {
    const pids = others();
    if (running()) child.kill(value);
    for (const pid of pids) signalProcess(pid, value);
  };
  const stopped = () => !running() && !others().length;
  let empty = false;
  signal("SIGTERM");
  const grace = Date.now() + 500;
  while (Date.now() < grace) {
    await Bun.sleep(25);
    const current = stopped();
    if (current && empty) { await exited; return; }
    empty = current;
  }

  // A TERM handler can spawn new processes, including detached ones. Keep
  // scanning after KILL until the flow has exited and ownership stays empty.
  const deadline = Date.now() + 500;
  while (Date.now() < deadline) {
    signal("SIGKILL");
    await Bun.sleep(25);
    const current = stopped();
    if (current && empty) { await exited; return; }
    empty = current;
  }
  throw new Error("owned flow processes did not stop");
}

/** Attempt every step even if an earlier one fails. A caller handling a primary error can log secondary errors. */
export async function cleanUp(steps: Array<() => PromiseLike<unknown>>, onError?: (error: unknown) => void) {
  const errors: unknown[] = [];
  for (const step of steps) {
    try { await step(); }
    catch (error) { errors.push(error); }
  }
  if (onError) { errors.forEach(onError); return; }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "e2e cleanup failed");
}
