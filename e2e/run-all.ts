// Runs the e2e/*.e2e.ts flows on several workers at once; add a flow by adding a file, no package.json edit needed.
// Usage: bun e2e/run-all.ts [--workers=N] [--keep] [--slow] [--dev] [name-filter ...]   (set CHROMIUM_PATH as for a single flow)
// The schema is migrated once into a template database; every flow gets a copy of it and a pair of ports of its worker's own, so flows never share rows or ports.
// E2E_PORT_BASE sets the first API port, or a default comes from the checkout's directory name. A busy port fails the flow and names the listener.
// Failed flows get a second attempt after the first queue and the report names those that passed only on retry.
import { randomBytes, randomUUID } from "node:crypto";
import { closeSync, openSync, readdirSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { SQL } from "bun";
import { waitFor } from "./harness";
import { listenerOn, resolvePortBase, workerPorts } from "./ports";
import { cleanUp, flowOwnerKey, runWithTimeout, stopProcess, withDeadline } from "./shutdown";
import { buildWorkerWeb } from "./web-build";
import { hostDefaultWorkers } from "./workers";

const args = process.argv.slice(2);
const keep = args.includes("--keep");
const dev = args.includes("--dev");
const sharedProductionFlows = new Set(["auth-submit-guard.e2e.ts", "sign-in-limits.e2e.ts"]);
const serviceWorkerSmoke = "mermaid-diagrams.e2e.ts";
const flowTimeoutMs = 10 * 60_000;
const workersFlag = args.find((arg) => arg.startsWith("--workers="));
const filters = args.filter((arg) => !arg.startsWith("--"));

// These flows run long sequences on a single page. --slow adds them to the queue.
const slowFlows = ["editor-parity.e2e.ts", "responsive.e2e.ts"];
const withSlow = args.includes("--slow");
const matching = readdirSync(import.meta.dir).filter((name) => name.endsWith(".e2e.ts") && (!filters.length || filters.some((filter) => name.includes(filter))) && (
  withSlow || !slowFlows.includes(name) || filters.some((filter) => filter === name || filter === name.replace(/\.e2e\.ts$/, ""))
));
const durationPath = join(import.meta.dir, "../.local/e2e/durations.json");
const durations: Record<string, number> = (await Bun.file(durationPath).json().catch(() => null)) ?? {};
const files = [...matching]
  .sort((a, b) => (durations[b] ?? 0) - (durations[a] ?? 0) || Number(slowFlows.includes(b)) - Number(slowFlows.includes(a)) || statSync(`${import.meta.dir}/${b}`).size - statSync(`${import.meta.dir}/${a}`).size || a.localeCompare(b));
const requestedWorkers = Number(workersFlag?.slice("--workers=".length));
if (workersFlag && (!Number.isSafeInteger(requestedWorkers) || requestedWorkers < 1)) {
  console.error("--workers must be a positive whole number");
  process.exit(1);
}
const workers = Math.max(1, Math.min(files.length, requestedWorkers || hostDefaultWorkers()));
let portBase: number;
try { portBase = resolvePortBase(Bun.env.E2E_PORT_BASE, basename(process.cwd()), workers); } catch (error) { console.error((error as Error).message); process.exit(1); }

const base = new URL(Bun.env.DATABASE_URL ?? "postgres://weft:weft@localhost:54329/weft");
const prefix = `weft_e2e_${basename(process.cwd()).toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 20) || "repo"}_${randomBytes(3).toString("hex")}`;
const urlFor = (name: string) => { const url = new URL(base); url.pathname = `/${name}`; return url.toString(); };
const logDir = process.env.TMPDIR ?? "/tmp";
const admin = new SQL({ url: base.toString(), connectionTimeout: 5 });
const created: string[] = [];
let webRoot: string | undefined;
let webDirectories: string[] = [];
let counter = 0;
let copying: Promise<void> = Promise.resolve();

/** The first port of the flow's set that something already listens on, as `port: listener`; the flow then does not start. */
function busyPort(ports: { api: number; web: number; live: number }): string | undefined {
  for (const port of [ports.api, ports.web, ports.live]) { const listener = listenerOn(port); if (listener) return `port ${port} is in use by ${listener}`; }
  return undefined;
}

/** Waits up to 5 s for a server that is still shutting down to release its ports; `left` is called for each port still in use after that. */
async function waitFree(ports: number[], left: (port: number, listener: string) => void) {
  for (const port of ports) {
    for (let n = 0; n < 50 && listenerOn(port); n += 1) await Bun.sleep(100);
    const listener = listenerOn(port);
    if (listener) left(port, listener);
  }
}

async function dropDatabase(database: string) {
  const drop = admin.unsafe(`drop database if exists ${database} with (force)`);
  try {
    await withDeadline(drop, 5_000, `drop e2e database ${database}`);
    created.splice(created.indexOf(database), 1);
  } catch (error) {
    drop.cancel();
    throw error;
  }
}

type FlowResult = { ok: boolean; blocked?: boolean; seconds: number; output: string };

/** One flow on a database of its own, with the ports of its worker. */
async function runFlow(file: string, worker: number): Promise<FlowResult> {
  const ports = workerPorts(portBase, worker);
  const busy = busyPort(ports);
  if (busy) return { ok: false, blocked: true, seconds: 0, output: `${file} did not start: ${busy}. Nothing was stopped; stop that process or set another E2E_PORT_BASE.` };
  const database = `${prefix}_f${counter++}`;
  const copy = copying.then(() => admin.unsafe(`create database ${database} template ${prefix}_tpl`));
  copying = copy.then(() => undefined, () => undefined);
  await copy;
  created.push(database);
  const started = Date.now();
  const logPath = `${logDir}/${prefix}_${file.replace(/\.e2e\.ts$/, "")}`;
  const runningLog = `${logPath}_running.log`;
  let ok = false;
  let failure = "";
  try {
    const owner = randomUUID();
    const env = {
      ...Bun.env,
      [flowOwnerKey]: owner,
      E2E_WEB_DIR: !dev ? webDirectories[worker] : undefined,
      E2E_PRODUCTION_WEB_DIR: webDirectories[worker],
      DATABASE_URL: urlFor(database),
      ALLOW_SIGNUP: "true",
      ALLOW_WORKSPACE_CREATION: "true",
      E2E_API_PORT: String(ports.api),
      E2E_WEB_PORT: String(ports.web),
      E2E_LIVE_PORT: String(ports.live),
    };
    // Servers inherit these descriptors. Write to a file so a leaked server cannot keep the runner waiting for pipe EOF.
    const fd = openSync(runningLog, "w");
    const run = (() => {
      try { return spawn(process.execPath, [join(import.meta.dir, file)], { env, detached: true, stdio: ["ignore", fd, fd] }); }
      finally { closeSync(fd); }
    })();
    ok = (await runWithTimeout(run, file, flowTimeoutMs, owner)) === 0;
  } catch (error) {
    console.error(String(error));
    failure = `\n${error}\n`;
  } finally {
    await cleanUp([
      async () => {
        await waitFree([ports.api, ports.web, ports.live], (port, left) => {
          failure += `\nwarning: ${file} left ${left} on port ${port}\n`;
          ok = false;
        });
      },
      async () => { if (!keep) await dropDatabase(database); },
    ], (error) => {
      failure += `\nwarning: ${error}\n`;
      ok = false;
    });
  }
  const seconds = Math.round((Date.now() - started) / 1000);
  if (ok) {
    await rename(runningLog, `${logPath}.log`);
    return { ok, seconds, output: "" };
  }
  const output = (await Bun.file(runningLog).exists() ? await Bun.file(runningLog).text() : "") + failure;
  await Bun.write(`${logPath}_failed.log`, output);
  await Bun.file(runningLog).delete().catch(() => undefined);
  return { ok, seconds, output };
}

async function runQueue(queue: string[], report: (file: string, result: FlowResult) => void) {
  const results = await Promise.allSettled(Array.from({ length: Math.min(workers, queue.length) }, async (_, worker) => {
    for (let file = queue.shift(); file; file = queue.shift()) report(file, await runFlow(file, worker));
  }));
  // Let every worker finish before the top-level cleanup drops its databases and closes the pool.
  const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "e2e worker errors");
}

if (files.length === 0) { console.log("no flow matches"); process.exit(1); }
const started = Date.now();
let code = 1;
try {
  await admin.unsafe(`create database ${prefix}_tpl`);
  created.push(`${prefix}_tpl`);
  const migrate = Bun.spawnSync(["bun", "run", "db:migrate"], { env: { ...Bun.env, DATABASE_URL: urlFor(`${prefix}_tpl`) }, stdout: "pipe", stderr: "pipe" });
  if (migrate.exitCode !== 0) { console.error(migrate.stdout.toString() + migrate.stderr.toString()); throw new Error("migration failed"); }

  if (files.some((file) => file !== serviceWorkerSmoke && (!dev || sharedProductionFlows.has(file)))) {
    console.log(`building the web app for ${workers} e2e workers`);
    webRoot = await mkdtemp(join(tmpdir(), "weft-e2e-run-"));
    webDirectories = await buildWorkerWeb(webRoot, Array.from({ length: workers }, (_, worker) => workerPorts(portBase, worker)));
  }

  if (dev) {
    // The web dev server optimises its dependencies on first start and reloads the page when it does; one start before the workers keeps that out of the flows.
    // The warm-up server uses worker 0's web port: it is stopped before any flow starts.
    const warmPort = workerPorts(portBase, 0).web;
    const busyWarm = listenerOn(warmPort);
    if (busyWarm) throw new Error(`port ${warmPort} is in use by ${busyWarm}; no flow started`);
    const warm = Bun.spawn(["node", "node_modules/vite/bin/vite.js", "--port", String(warmPort), "--strictPort"], { cwd: `${import.meta.dir}/../apps/web`, env: { ...Bun.env, VITE_API_URL: "http://localhost:1" }, stdout: "ignore", stderr: "ignore" });
    try {
      await waitFor(`http://localhost:${warmPort}/`, warm);
    } finally {
      await stopProcess(warm);
    }
    await waitFree([warmPort], (port, listener) => { throw new Error(`warm-up server still holds port ${port}: ${listener}; no flow started`); });
  }

  console.log(`${files.length} flows on ${workers} workers, a database and a pair of ports for each (API ${portBase}+, web ${portBase + 20_000}+, E2E_PORT_BASE ${Bun.env.E2E_PORT_BASE ? "set" : "derived from the directory name"})`);
  const failed: { file: string; output: string; blocked?: boolean }[] = [];
  await runQueue([...files], (file, result) => {
    console.log(`${result.ok ? "ok  " : "FAIL"} ${file} (${result.seconds}s)`);
    if (result.ok && !dev) durations[file] = result.seconds;
    if (!result.ok) failed.push({ file, output: result.output, blocked: result.blocked });
  });

  // Each flow that failed runs once more, on the same workers: it is only a few flows now, and a flow that missed a wait under load usually passes the second time.
  // A flow blocked by a busy port would fail the same way again, so it is not retried.
  const stillFailing: { file: string; output: string }[] = failed.filter((flow) => flow.blocked);
  const retried: string[] = [];
  const again = failed.filter((flow) => !flow.blocked).map((flow) => flow.file);
  await runQueue(again, (file, result) => {
    console.log(`${result.ok ? "ok  " : "FAIL"} ${file} again (${result.seconds}s)`);
    if (result.ok) {
      retried.push(file);
      if (!dev) durations[file] = result.seconds;
    } else stillFailing.push({ file, output: result.output });
  });
  if (!dev) {
    try {
      const temporary = `${durationPath}.${prefix}`;
      await mkdir(dirname(durationPath), { recursive: true });
      await Bun.write(temporary, JSON.stringify(durations, null, 2) + "\n");
      await rename(temporary, durationPath);
    } catch (error) { console.warn(`could not save flow durations: ${error}`); }
  }
  // The last non-log lines of each failure; the whole output of every flow is in the log directory.
  for (const { file, output } of stillFailing) {
    const lines = output.split("\n").filter((line) => !line.startsWith('{"time"'));
    // The thrown message first, because the stack frames below it push it out of the last lines.
    const message = lines.find((line) => /^(error|Error|TimeoutError)\b/.test(line));
    console.log(`\n=== ${file}${message ? `\n${message}` : ""}\n${lines.slice(-12).join("\n")}`);
  }
  console.log(`\nlogs: ${logDir}/${prefix}_*.log`);
  console.log(`\ne2e ${stillFailing.length ? `FAILED: ${stillFailing.map((flow) => flow.file).join(", ")}` : `all ok (${files.length} flows)`} in ${Math.round((Date.now() - started) / 1000)}s`);
  if (retried.length) console.log(`passed only on the second run (flaky under load): ${retried.join(", ")}`);
  code = stillFailing.length ? 1 : 0;
} finally {
  try {
    if (keep) console.log(`kept ${created.join(", ")}`);
    else await cleanUp([...created].reverse().map((name) => () => dropDatabase(name)), (error) => {
      console.error(error);
      code = 1;
    });
  } finally {
    await cleanUp([
      () => withDeadline(admin.close({ timeout: 1 }), 5_000, "runner database close"),
      async () => { if (webRoot) await rm(webRoot, { recursive: true, force: true }); },
    ], (error) => {
      console.error(error);
      code = 1;
    });
  }
}
process.exit(code);
