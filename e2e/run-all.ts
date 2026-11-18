// Runs the e2e/*.e2e.ts flows on several workers at once; add a flow by adding a file, no package.json edit needed.
// Usage: bun e2e/run-all.ts [--workers=N] [--keep] [--slow] [name-filter]   (set CHROMIUM_PATH as for a single flow)
// The schema is migrated once into a template database; every flow gets a copy of it and a pair of ports of its worker's own, so flows never share rows or ports.
// Ports: E2E_PORT_BASE (whole number, at most 45534) sets them; unset, the base comes from the checkout's directory name. A flow whose port is busy fails at once, naming the listener; nothing is killed.
// A flow that fails while the others run is run once more on its own: a browser flow under load can miss a wait that it passes on a quiet machine, and the report says which flows needed it.
import { randomBytes } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { availableParallelism } from "node:os";
import { basename } from "node:path";
import { SQL } from "bun";
import { listenerOn, resolvePortBase, workerPorts } from "./ports";

const args = process.argv.slice(2);
const keep = args.includes("--keep");
const workersFlag = args.find((arg) => arg.startsWith("--workers="));
const filter = args.find((arg) => !arg.startsWith("--"));
let portBase: number;
try { portBase = resolvePortBase(Bun.env.E2E_PORT_BASE, basename(process.cwd())); } catch (error) { console.error((error as Error).message); process.exit(1); }

/**
 * The two longest flows (measured 2026-11-16: editor-parity 240 s, responsive 130 s with its viewports side by side). Each is one long sequence on one page, so they cannot be split over workers, and either one alone sets the length of the whole run.
 * The default run leaves them out; `--slow` (`bun run e2e:slow`) adds them, first in the queue. Run it after changing the editor, or the layout of many screens.
 */
const slowFlows = ["editor-parity.e2e.ts", "responsive.e2e.ts"];
const withSlow = args.includes("--slow");
const matching = readdirSync(import.meta.dir).filter((name) => name.endsWith(".e2e.ts") && (!filter || name.includes(filter)) && (withSlow || !slowFlows.includes(name) || filter === name.replace(/\.e2e\.ts$/, "")));
const files = [...matching]
  .sort((a, b) => Number(slowFlows.includes(b)) - Number(slowFlows.includes(a)) || statSync(`${import.meta.dir}/${b}`).size - statSync(`${import.meta.dir}/${a}`).size || a.localeCompare(b));
const workers = Math.max(1, Math.min(files.length, Number(workersFlag?.slice("--workers=".length)) || Math.min(6, Math.max(2, availableParallelism() - 6))));

const base = new URL(Bun.env.DATABASE_URL ?? "postgres://weft:weft@localhost:54329/weft");
const prefix = `weft_e2e_${basename(process.cwd()).toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 20) || "repo"}_${randomBytes(3).toString("hex")}`;
const urlFor = (name: string) => { const url = new URL(base); url.pathname = `/${name}`; return url.toString(); };
const logDir = process.env.TMPDIR ?? "/tmp";
const admin = new SQL(base.toString());
const created: string[] = [];
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

/** One flow on a database of its own, with the ports of its worker. */
async function runFlow(file: string, worker: number): Promise<{ ok: boolean; blocked?: boolean; seconds: number; output: string }> {
  const ports = workerPorts(portBase, worker);
  const busy = busyPort(ports);
  if (busy) return { ok: false, blocked: true, seconds: 0, output: `${file} did not start: ${busy}. Nothing was stopped; stop that process or set another E2E_PORT_BASE.` };
  const database = `${prefix}_f${counter++}`;
  const copy = copying.then(() => admin.unsafe(`create database ${database} template ${prefix}_tpl`));
  copying = copy.then(() => undefined, () => undefined);
  await copy;
  created.push(database);
  const started = Date.now();
  try {
    const env = { ...Bun.env, DATABASE_URL: urlFor(database), ALLOW_SIGNUP: "true", ALLOW_WORKSPACE_CREATION: "true", E2E_API_PORT: String(ports.api), E2E_WEB_PORT: String(ports.web), E2E_LIVE_PORT: String(ports.live) };
    const run = Bun.spawn(["bun", `${import.meta.dir}/${file}`], { env, stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text()]);
    const ok = (await run.exited) === 0;
    await Bun.write(`${logDir}/${prefix}_${file.replace(/\.e2e\.ts$/, "")}${ok ? "" : "_failed"}.log`, out + err);
    return { ok, seconds: Math.round((Date.now() - started) / 1000), output: out + err };
  } finally {
    // A server the flow left behind is reported, not killed: the next flow on this worker then fails at once, naming it.
    await waitFree([ports.api, ports.web, ports.live], (port, left) => console.log(`warning: ${file} left ${left} on port ${port}`));
    if (!keep) { await admin.unsafe(`drop database if exists ${database} with (force)`); created.splice(created.indexOf(database), 1); }
  }
}

if (files.length === 0) { console.log("no flow matches"); process.exit(1); }
const started = Date.now();
let code = 1;
try {
  await admin.unsafe(`create database ${prefix}_tpl`);
  created.push(`${prefix}_tpl`);
  const migrate = Bun.spawnSync(["bun", "run", "db:migrate"], { env: { ...Bun.env, DATABASE_URL: urlFor(`${prefix}_tpl`) }, stdout: "pipe", stderr: "pipe" });
  if (migrate.exitCode !== 0) { console.error(migrate.stdout.toString() + migrate.stderr.toString()); throw new Error("migration failed"); }

  // The web dev server optimises its dependencies on first start and reloads the page when it does; one start before the workers keeps that out of the flows.
  // The warm-up server uses worker 0's web port: it is stopped before any flow starts.
  const warmPort = workerPorts(portBase, 0).web;
  const busyWarm = listenerOn(warmPort);
  if (busyWarm) throw new Error(`port ${warmPort} is in use by ${busyWarm}; no flow started`);
  const warm = Bun.spawn(["bunx", "vite", "--port", String(warmPort), "--strictPort"], { cwd: `${import.meta.dir}/../apps/web`, env: { ...Bun.env, VITE_API_URL: "http://localhost:1" }, stdout: "ignore", stderr: "ignore" });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { if ((await fetch(`http://localhost:${warmPort}/`)).status < 500) break; } catch { /* not up yet */ }
    await Bun.sleep(200);
  }
  warm.kill();
  await warm.exited;
  await waitFree([warmPort], (port, listener) => { throw new Error(`warm-up server still holds port ${port}: ${listener}; no flow started`); });

  console.log(`${files.length} flows on ${workers} workers, a database and a pair of ports for each (API ${portBase}+, web ${portBase + 20_000}+, E2E_PORT_BASE ${Bun.env.E2E_PORT_BASE ? "set" : "derived from the directory name"})`);
  const queue = [...files];
  const failed: { file: string; output: string; blocked?: boolean }[] = [];
  const passed: string[] = [];
  await Promise.all(Array.from({ length: workers }, async (_, worker) => {
    for (let file = queue.shift(); file; file = queue.shift()) {
      const result = await runFlow(file, worker);
      console.log(`${result.ok ? "ok  " : "FAIL"} ${file} (${result.seconds}s)`);
      if (result.ok) passed.push(file); else failed.push({ file, output: result.output, blocked: result.blocked });
    }
  }));

  // Each flow that failed runs once more, on the same workers: it is only a few flows now, and a flow that missed a wait under load usually passes the second time.
  // A flow blocked by a busy port would fail the same way again, so it is not retried.
  const stillFailing: { file: string; output: string }[] = failed.filter((flow) => flow.blocked);
  const retried: string[] = [];
  const again = failed.filter((flow) => !flow.blocked).map((flow) => flow.file);
  await Promise.all(Array.from({ length: Math.min(workers, again.length) }, async (_, worker) => {
    for (let file = again.shift(); file; file = again.shift()) {
      const result = await runFlow(file, worker);
      console.log(`${result.ok ? "ok  " : "FAIL"} ${file} again (${result.seconds}s)`);
      if (result.ok) retried.push(file); else stillFailing.push({ file, output: result.output });
    }
  }));
  // The last non-log lines of each failure; the whole output of every flow is in the log directory.
  for (const { file, output } of stillFailing) console.log(`\n=== ${file}\n${output.split("\n").filter((line) => !line.startsWith('{"time"')).slice(-12).join("\n")}`);
  console.log(`\nlogs: ${logDir}/${prefix}_*.log`);
  console.log(`\ne2e ${stillFailing.length ? `FAILED: ${stillFailing.map((flow) => flow.file).join(", ")}` : `all ok (${files.length} flows)`} in ${Math.round((Date.now() - started) / 1000)}s`);
  if (retried.length) console.log(`passed only on the second run (flaky under load): ${retried.join(", ")}`);
  code = stillFailing.length ? 1 : 0;
} finally {
  if (keep) console.log(`kept ${created.join(", ")}`);
  else for (const name of created) await admin.unsafe(`drop database if exists ${name} with (force)`);
  await admin.close();
}
process.exit(code);
