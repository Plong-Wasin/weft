// Runs the test suite against throwaway databases of its own, so parallel runs (other worktrees, workers, CI) never share rows or schema.
// Usage: bun scripts/test-isolated.ts [--verbose] [--keep] [--slow] [--workers=N] [bun test args...]
// The server comes from DATABASE_URL (default: the local weft-postgres service); only the database names change.
//
// The whole suite runs on several workers at once, because bun runs test files one after another inside a process and most of the time goes to
// waiting on the database. The schema is migrated once into a template database and each worker gets a copy of it (`create database ... template`),
// so workers never see each other's rows. Workers take test files from one queue, largest file first, and run each file as its own `bun test`
// process, so a slow file never leaves the other workers idle. Any file or filter argument runs one process on one database instead.
import { randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { availableParallelism } from "node:os";
import { basename } from "node:path";
import { SQL } from "bun";

const args = Bun.argv.slice(2);
const verbose = args.includes("--verbose");
const keep = args.includes("--keep");
const withSlow = args.includes("--slow");
const workersFlag = args.find((arg) => arg.startsWith("--workers="));
const testArgs: string[] = args.filter((arg) => arg !== "--verbose" && arg !== "--keep" && arg !== "--slow" && arg !== workersFlag);
// An argument that is not a flag names a file or a test filter: that run stays in one process.
// Twenty tests at once in each of eight processes starves the database and the CPU; four per file keeps the 5 s test timeout honest.
if (!testArgs.some((arg) => arg.startsWith("--max-concurrency"))) testArgs.push("--max-concurrency=4");
const narrowed = testArgs.some((arg, index) => !arg.startsWith("-") && !(index > 0 && /^--(max-concurrency|timeout|rerun-each|bail)$/.test(testArgs[index - 1]!)));

const base = new URL(Bun.env.DATABASE_URL ?? "postgres://weft:weft@localhost:54329/weft");
const worktree = basename(process.cwd()).toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 24) || "repo";
const prefix = `weft_test_${worktree}_${randomBytes(3).toString("hex")}`;
const urlFor = (name: string) => { const url = new URL(base); url.pathname = `/${name}`; return url.toString(); };

// Bun loads the developer's .env into the test process; a closed gate there (ALLOW_WORKSPACE_CREATION=false) makes tests that create workspaces fail with 403/422.
// Tests that need a closed gate pass their own gates to createApp, so the suite pins the defaults.
// SMTP_HOST is cleared and MAIL_TRANSPORT is pinned to smtp so a developer's .env (SMTP or Microsoft Graph) cannot send real mail from the suite; email tests run their own local SMTP sink and fake Graph server.
// WEFT_AI_ENABLED is on for the suite too, so AI surface tests need no setup; a key-less server still counts AI as off (aiState), so AI tests pass features.ai. apps/api/test/ai-default.test.ts proves the real default.
// WEFT_INTEGRATIONS_ENABLED is on for the suite so integration tests need no setup. Every test of the off path sets the flag off itself
// (explicit `integrations: false`, or an env without it), and apps/api/test/integration-default-off.test.ts proves the real unset default in a child process.
const envFor = (databaseUrl: string) => ({ ...Bun.env, DATABASE_URL: databaseUrl, ALLOW_SIGNUP: "true", ALLOW_WORKSPACE_CREATION: "true", PASSWORD_BREACH_CHECK: "off", SMTP_HOST: "", MAIL_TRANSPORT: "smtp", WEFT_INTEGRATIONS_ENABLED: "true", WEFT_AI_ENABLED: "true" });

/** Files that time themselves against a deadline with the CPU (converter limits, backfill, the Daemon black box). They fail when other files load the machine, so they run after the queue, when the machine is quiet. */
const timingSensitive = /written-form-(limits|round7)|migrate-schema-only|apps\/cli\/test\/daemon\.test|packages\/actions\/test\/(runtimes|comments|registry-permissions)\.test|apps\/api\/test\/(run-token-gate|rate-limits)\.test/;
/** Timing-sensitive files that also take over four minutes of test time between them (the Written form fair queue, probation, pool fairness, fuzz and worker files, and the backfill). The default run leaves them out; `--slow` (`bun run test:slow`) adds them. Run it after changing the Written form converter or its queue, or the backfill. */
const slow = /written-form-(fair-queue|probation|pool-fairness|fuzz|worker)|migration-backfill/;

/** The files that take longest in the default run (measured 2026-11-16, 20-40 s each): they start first, so the run never ends on one of them. */
const startFirst = /rate-limits|stored-read-cap|round7-reads|read-handlers-under-key|apps\/live\/test\/server/;

/** Every test file bun would pick up: the slowest known first, then the rest largest first (big files tend to be slow). */
async function testFiles(): Promise<string[]> {
  const glob = new Bun.Glob("**/*{.test,_test,.spec,_spec}.{js,jsx,ts,tsx,mjs,cjs}");
  const files: { path: string; size: number }[] = [];
  for await (const path of glob.scan({ cwd: process.cwd() })) if (!path.includes("node_modules")) files.push({ path, size: statSync(path).size });
  files.sort((a, b) => Number(startFirst.test(b.path)) - Number(startFirst.test(a.path)) || b.size - a.size || a.path.localeCompare(b.path));
  return files.map((file) => `./${file.path}`);
}

const admin = new SQL(base.toString());
let fileCounter = 0;
let copying: Promise<void> = Promise.resolve();
const created: string[] = [];
const create = async (sql: string, name: string) => { await admin.unsafe(sql); created.push(name); };
let code = 1;
try {
  const started = Date.now();
  const template = `${prefix}_tpl`;
  await create(`create database ${template}`, template);
  const migrate = Bun.spawnSync(["bun", "run", "db:migrate"], { env: envFor(urlFor(template)), stdout: "pipe", stderr: "pipe" });
  if (migrate.exitCode !== 0) { console.error(migrate.stdout.toString() + migrate.stderr.toString()); throw new Error("migration failed"); }

  if (narrowed) {
    const name = `${prefix}_one`;
    await create(`create database ${name} template ${template}`, name);
    console.log(`test database ${name}`);
    code = await runOne(name, testArgs, `${process.env.TMPDIR ?? "/tmp"}/${name}.log`);
  } else {
    const count = Math.max(1, Number(workersFlag?.slice("--workers=".length)) || Math.min(8, Math.max(2, availableParallelism() - 4)));
    const all = (await testFiles()).filter((file) => withSlow || !slow.test(file));
    const total = all.length;
    const queue = all.filter((file) => !timingSensitive.test(file) && !slow.test(file));
    const alone = all.filter((file) => timingSensitive.test(file) || slow.test(file));
    console.log(`${count} workers, then the timing-sensitive files two at a time; ${total} files${withSlow ? " (slow ones included)" : ", slow ones left out: bun run test:slow"}, a database of its own for each file`);
    const totals = { pass: 0, fail: 0, tests: 0, failedFiles: 0 };
    const logDir = process.env.TMPDIR ?? "/tmp";
    // One worker drains a list of files; the pool shares `queue`, the timing-sensitive lane has a list of its own and starts with the pool, so its slow files overlap the pool's end.
    const drain = async (lane: string, next: () => string | undefined) => {
      let log = "";
      for (let file = next(); file; file = next()) log += await runFile(file, testArgs, totals);
      await Bun.write(`${logDir}/${prefix}_${lane}.log`, log);
    };
    await Promise.all(Array.from({ length: count }, (_, index) => drain(`w${index}`, () => queue.shift())));
    // The timing-sensitive files run once the pool is done and the machine is quiet, a few at a time: most of their time is waiting on purpose, not computing. With two workers or fewer (a two-core CI runner) they run one at a time, because two of them side by side use up the cores their deadlines count on.
    await Promise.all(Array.from({ length: Math.min(count > 2 ? 2 : 1, alone.length) }, (_, index) => drain(`alone${index}`, () => alone.shift())));
    console.log(`${totals.pass} pass\n${totals.fail} fail\nRan ${totals.tests} tests across ${total} files in ${Math.round((Date.now() - started) / 1000)}s`);
    console.log(`logs: ${logDir}/${prefix}_*.log`);
    code = totals.fail === 0 && totals.failedFiles === 0 ? 0 : 1;
  }
} finally {
  if (keep) console.log(`kept ${created.join(", ")}; use DATABASE_URL=${urlFor(created.at(-1) ?? "")}`);
  else for (const name of created) await admin.unsafe(`drop database if exists ${name} with (force)`);
  await admin.close();
}
process.exit(code);

/** Runs one test file on a worker's database and adds its counts to `totals`. Failing test names print at once; the file's full output is returned for the worker's log. */
async function runFile(file: string, bunArgs: string[], totals: { pass: number; fail: number; tests: number; failedFiles: number }): Promise<string> {
  // A database of its own per file: committed rows (queued jobs, say) can never leak from one file into the next, whatever order the queue gives.
  // `create database ... template` refuses to run twice at once on one template, so the copies are made one at a time.
  const database = `${prefix}_f${fileCounter++}`;
  const copy = copying.then(() => admin.unsafe(`create database ${database} template ${prefix}_tpl`));
  copying = copy.then(() => undefined, () => undefined);
  await copy;
  created.push(database);
  try {
    return await runFileOn(database, file, bunArgs, totals);
  } finally {
    if (!keep) { await admin.unsafe(`drop database if exists ${database} with (force)`); created.splice(created.indexOf(database), 1); }
  }
}

async function runFileOn(database: string, file: string, bunArgs: string[], totals: { pass: number; fail: number; tests: number; failedFiles: number }): Promise<string> {
  const run = Bun.spawn(["bun", "test", "--concurrent", ...bunArgs, file], { env: envFor(urlFor(database)), stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text()]);
  const exitCode = await run.exited;
  const output = out + err;
  const count = (label: string) => Number(output.match(new RegExp(`^\\s*(\\d+) ${label}$`, "m"))?.[1] ?? 0);
  const pass = count("pass"), fail = count("fail");
  totals.pass += pass; totals.fail += fail; totals.tests += pass + fail;
  // A file that exits non-zero with no failing test (a crash, an unhandled error between tests) still fails the run.
  if (exitCode !== 0 && fail === 0) { totals.failedFiles += 1; console.log(`(fail) ${escapeControlChars(file)} exited with code ${exitCode}`); }
  for (const line of output.split("\n").filter((line) => line.startsWith("(fail)"))) console.log(`${escapeControlChars(line)}  <- ${escapeControlChars(file)}`);
  if (process.env.GITHUB_ACTIONS === "true" && (exitCode !== 0 || fail > 0)) {
    const diagnostics = output.split("\n").slice(-80).join("\n").slice(-12_000);
    const redactedDiagnostics = diagnostics.replace(/(postgres(?:ql)?:\/\/[^:\s/]+:)[^@\s/]+(@)/gi, "$1[redacted]$2");
    const groupTitle = escapeControlChars(file).slice(0, 200);
    console.log(`::group::Failure details for ${groupTitle} (last 80 lines, 12,000 characters max)`);
    console.log(redactedDiagnostics ? redactedDiagnostics.split("\n").map((line) => `  ${escapeControlChars(line)}`).join("\n") : "  The test process exited without diagnostic output.");
    console.log("::endgroup::");
  }
  return `===== ${file} (exit ${exitCode})\n${output}\n`;
}

/** Prevent test-controlled filenames/output from becoming GitHub Actions workflow commands. */
function escapeControlChars(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, (char) => `\\u${char.codePointAt(0)!.toString(16).padStart(4, "0")}`);
}

/** Runs `bun test` on one database. Quiet runs print only the failing test names and the totals; the full output goes to `logFile`. */
async function runOne(database: string, bunArgs: string[], logFile: string, label = ""): Promise<number> {
  const env = envFor(urlFor(database));
  const tag = label ? `[${label}] ` : "";
  if (verbose) return Bun.spawn(["bun", "test", "--concurrent", ...bunArgs], { env, stdout: "inherit", stderr: "inherit" }).exited;
  const run = Bun.spawn(["bun", "test", "--concurrent", ...bunArgs], { env, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text()]);
  const exitCode = await run.exited;
  const output = out + err;
  await Bun.write(logFile, output);
  const lines = output.split("\n");
  const failed = lines.filter((line) => line.startsWith("(fail)"));
  for (const line of failed.slice(0, 20)) console.log(`${tag}${escapeControlChars(line)}`);
  if (failed.length > 20) console.log(`${tag}... ${failed.length - 20} more failures`);
  for (const line of lines.filter((line) => /^\s*\d+ (pass|fail)$|^Ran \d+ tests/.test(line))) console.log(`${tag}${line.trim()}`);
  console.log(`${tag}full output: ${logFile}`);
  return exitCode;
}
