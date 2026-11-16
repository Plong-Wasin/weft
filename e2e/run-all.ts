// Runs the e2e/*.e2e.ts flows on several workers at once; add a flow by adding a file, no package.json edit needed.
// Usage: bun e2e/run-all.ts [--workers=N] [--keep] [--slow] [name-filter]   (set CHROMIUM_PATH as for a single flow)
// The schema is migrated once into a template database; every flow gets a copy of it and a pair of ports of its worker's own, so flows never share rows or ports.
// A flow that fails while the others run is run once more on its own: a browser flow under load can miss a wait that it passes on a quiet machine, and the report says which flows needed it.
import { randomBytes } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { availableParallelism } from "node:os";
import { basename } from "node:path";
import { SQL } from "bun";

const args = process.argv.slice(2);
const keep = args.includes("--keep");
const workersFlag = args.find((arg) => arg.startsWith("--workers="));
const filter = args.find((arg) => !arg.startsWith("--"));

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
const portBase = Number(Bun.env.E2E_PORT_BASE ?? 33100);
const admin = new SQL(base.toString());
const created: string[] = [];
let counter = 0;
let copying: Promise<void> = Promise.resolve();

/** Kills whatever still listens on the given ports: the servers a flow left behind (a flow that failed may not have stopped its API) would make the next flow of this worker fail with "port in use". */
function freePorts(ports: number[]) {
  for (const port of ports) {
    const listeners = Bun.spawnSync(["lsof", "-ti", `tcp:${port}`, "-sTCP:LISTEN"], { stdout: "pipe", stderr: "ignore" }).stdout.toString().split("\n").filter(Boolean);
    for (const pid of listeners) Bun.spawnSync(["kill", "-9", pid], { stdout: "ignore", stderr: "ignore" });
  }
}

/** One flow on a database of its own, with the ports of its worker. */
async function runFlow(file: string, worker: number): Promise<{ ok: boolean; seconds: number; output: string }> {
  const database = `${prefix}_f${counter++}`;
  const copy = copying.then(() => admin.unsafe(`create database ${database} template ${prefix}_tpl`));
  copying = copy.then(() => undefined, () => undefined);
  await copy;
  created.push(database);
  const started = Date.now();
  try {
    const ports = [portBase + worker * 2, portBase + 20_000 + worker * 2];
    freePorts(ports);
    const env = { ...Bun.env, DATABASE_URL: urlFor(database), ALLOW_SIGNUP: "true", ALLOW_WORKSPACE_CREATION: "true", E2E_API_PORT: String(portBase + worker * 2), E2E_WEB_PORT: String(portBase + 20_000 + worker * 2) };
    const run = Bun.spawn(["bun", `${import.meta.dir}/${file}`], { env, stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text()]);
    const ok = (await run.exited) === 0;
    await Bun.write(`${logDir}/${prefix}_${file.replace(/\.e2e\.ts$/, "")}${ok ? "" : "_failed"}.log`, out + err);
    return { ok, seconds: Math.round((Date.now() - started) / 1000), output: out + err };
  } finally {
    freePorts([portBase + worker * 2, portBase + 20_000 + worker * 2]);
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
  const warm = Bun.spawn(["bunx", "vite", "--port", String(portBase + 20_000 + 98), "--strictPort"], { cwd: `${import.meta.dir}/../apps/web`, env: { ...Bun.env, VITE_API_URL: "http://localhost:1" }, stdout: "ignore", stderr: "ignore" });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { if ((await fetch(`http://localhost:${portBase + 20_000 + 98}/`)).status < 500) break; } catch { /* not up yet */ }
    await Bun.sleep(200);
  }
  warm.kill();
  await warm.exited;

  console.log(`${files.length} flows on ${workers} workers, a database and a pair of ports for each`);
  const queue = [...files];
  const failed: { file: string; output: string }[] = [];
  const passed: string[] = [];
  await Promise.all(Array.from({ length: workers }, async (_, worker) => {
    for (let file = queue.shift(); file; file = queue.shift()) {
      const result = await runFlow(file, worker);
      console.log(`${result.ok ? "ok  " : "FAIL"} ${file} (${result.seconds}s)`);
      if (result.ok) passed.push(file); else failed.push({ file, output: result.output });
    }
  }));

  // Each flow that failed runs once more, on the same workers: it is only a few flows now, and a flow that missed a wait under load usually passes the second time.
  const stillFailing: { file: string; output: string }[] = [];
  const retried: string[] = [];
  const again = failed.map((flow) => flow.file);
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
