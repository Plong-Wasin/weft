// Runs the test suite against a throwaway database of its own, so parallel runs (other worktrees, workers, CI) never share rows or schema.
// Usage: bun scripts/test-isolated.ts [--verbose] [--keep] [bun test args...]
// The server comes from DATABASE_URL (default: the local weft-postgres service); only the database name changes.
import { randomBytes } from "node:crypto";
import { basename } from "node:path";
import { SQL } from "bun";

const args = Bun.argv.slice(2);
const verbose = args.includes("--verbose");
const keep = args.includes("--keep");
const testArgs = args.filter((arg) => arg !== "--verbose" && arg !== "--keep");

const base = new URL(Bun.env.DATABASE_URL ?? "postgres://weft:weft@localhost:54329/weft");
const worktree = basename(process.cwd()).toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 24) || "repo";
const name = `weft_test_${worktree}_${randomBytes(3).toString("hex")}`;
const target = new URL(base);
target.pathname = `/${name}`;

const admin = new SQL(base.toString());
await admin.unsafe(`create database ${name}`);
console.log(`test database ${name}`);

let code = 1;
try {
  // Bun loads the developer's .env into the test process; a closed gate there (ALLOW_WORKSPACE_CREATION=false) makes tests that create workspaces fail with 403/422.
  // Tests that need a closed gate pass their own gates to createApp, so the suite pins the defaults.
  const env = { ...Bun.env, DATABASE_URL: target.toString(), ALLOW_SIGNUP: "true", ALLOW_WORKSPACE_CREATION: "true" };
  const migrate = Bun.spawnSync(["bun", "run", "db:migrate"], { env, stdout: "pipe", stderr: "pipe" });
  if (migrate.exitCode !== 0) { console.error(migrate.stdout.toString() + migrate.stderr.toString()); throw new Error("migration failed"); }
  const logFile = `${process.env.TMPDIR ?? "/tmp"}/${name}.log`;
  if (verbose) {
    code = (await Bun.spawn(["bun", "test", "--concurrent", ...testArgs], { env, stdout: "inherit", stderr: "inherit" }).exited);
  } else {
    // Keep the console short: the full output goes to a file, the console gets the failures and the totals.
    const run = Bun.spawnSync(["bun", "test", "--concurrent", ...testArgs], { env, stdout: "pipe", stderr: "pipe" });
    const output = run.stdout.toString() + run.stderr.toString();
    await Bun.write(logFile, output);
    const lines = output.split("\n");
    const failed = lines.filter((line) => line.startsWith("(fail)"));
    for (const line of failed.slice(0, 20)) console.log(line);
    if (failed.length > 20) console.log(`... ${failed.length - 20} more failures`);
    for (const line of lines.filter((line) => /^\s*\d+ (pass|fail)$|^Ran \d+ tests/.test(line))) console.log(line.trim());
    console.log(`full output: ${logFile}`);
    code = run.exitCode ?? 1;
  }
} finally {
  if (keep) console.log(`kept ${name}; use DATABASE_URL=${target.toString()}`);
  else await admin.unsafe(`drop database if exists ${name} with (force)`);
  await admin.close();
}
process.exit(code);
