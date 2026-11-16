import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Stub `docker compose` and `docker`: each call is appended to a log, and the answers come from environment variables.
const stub = (dir: string, name: string, body: string) => {
  const path = join(dir, name);
  writeFileSync(path, `#!/usr/bin/env bash\necho "$0 $*" >> "$STUB_LOG"\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
};

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "weft-backup-test-"));
  const log = join(dir, "calls.log");
  writeFileSync(log, "");
  const compose = stub(dir, "compose", `
case "$*" in
  *"config --services"*) echo "$STUB_SERVICES" ;;
  *"ps -a -q api"*) echo "cid-api" ;;
  *"psql"*"--single-transaction"*) if [ -n "$STUB_FAIL_PSQL" ]; then exit 1; fi ;;
  "build"|*" build"*) if [ -n "$STUB_FAIL_BUILD" ]; then exit 1; fi ;;
  *"run --build --rm migrate"*) if [ -n "$STUB_FAIL_MIGRATE" ]; then exit 1; fi ;;
  *"__drizzle_migrations"*) echo "88" ;;
  *"psql"*) echo "\${STUB_TABLES:-0}" ;;
  *"pg_dump"*) echo "DUMP-BYTES" ;;
  *"pg_restore -f /dev/null"*) if [ -n "$STUB_BAD_DUMP" ]; then exit 1; fi; cat > /dev/null ;;
  *"pg_restore"*|*"cat >"*) cat > /dev/null ;;
esac
exit 0`);
  const docker = stub(dir, "docker", `
case "$*" in
  *"config_files"*) echo "$STUB_CONFIG_FILES" ;;
  *"volume inspect"*) if [ -n "$STUB_NO_VOLUME" ]; then exit 1; fi ;;
  *"-czf"*) for arg in "$@"; do case "$arg" in *:/backup) echo "TAR-BYTES" > "\${arg%:/backup}/uploads.tar.gz" ;; esac; done ;;
  *"wc -l"*) echo "\${STUB_ENTRIES:-0}" ;;
esac
exit 0`);
  const env = { ...Bun.env, WEFT_BACKUPS_DIR: join(dir, "pre-restore"), STUB_LOG: log, WEFT_COMPOSE: compose, WEFT_DOCKER: docker, STUB_TABLES: "0", STUB_ENTRIES: "0", STUB_SERVICES: "api\nweb", STUB_CONFIG_FILES: "/srv/weft/compose.yaml" };
  return { dir, log, env, calls: () => readFileSync(log, "utf8") };
}

const run = (script: string, args: string[], env: Record<string, string | undefined>) => {
  const result = Bun.spawnSync(["bash", join(import.meta.dir, "..", "scripts", script), ...args], { env: env as Record<string, string>, stdout: "pipe", stderr: "pipe" });
  return { code: result.exitCode, out: result.stdout.toString() + result.stderr.toString() };
};

test("backup writes the database, uploads, migration level and checksums, pausing the file store only while it copies", () => {
  const t = setup();
  try {
    const target = join(t.dir, "backup");
    const result = run("backup.sh", [target], t.env);
    expect(result.code).toBe(0);
    expect(readFileSync(join(target, "database.dump"), "utf8")).toBe("DUMP-BYTES\n");
    expect(readFileSync(join(target, "uploads.tar.gz"), "utf8")).toBe("TAR-BYTES\n");
    expect(readFileSync(join(target, "migration-level.txt"), "utf8").trim()).toBe("88");
    expect(readFileSync(join(target, "SHA256SUMS"), "utf8")).toContain("database.dump");
    const calls = t.calls();
    expect(calls.indexOf("stop minio")).toBeLessThan(calls.indexOf("-czf"));
    expect(calls.lastIndexOf("start minio")).toBeGreaterThan(calls.indexOf("-czf"));
  } finally { rmSync(t.dir, { recursive: true, force: true }); }
});

test("backup refuses a folder that already exists, so an older backup is never overwritten", () => {
  const t = setup();
  try {
    const result = run("backup.sh", [t.dir], t.env);
    expect(result.code).toBe(1);
    expect(result.out).toContain("already exists");
    expect(t.calls()).not.toContain("pg_dump");
  } finally { rmSync(t.dir, { recursive: true, force: true }); }
});

test("restore refuses to overwrite a live database without --replace-live-database, and changes nothing", () => {
  const t = setup();
  try {
    const target = join(t.dir, "backup");
    expect(run("backup.sh", [target], t.env).code).toBe(0);
    const before = t.calls().length; // the log is append-only, so the new calls start at this offset
    const result = run("restore.sh", [target], { ...t.env, STUB_TABLES: "42" });
    expect(result.code).toBe(3);
    expect(result.out).toContain("already has data");
    expect(result.out).toContain("--replace-live-database");
    const calls = t.calls().slice(before);
    expect(calls).not.toContain("pg_restore");
    expect(calls).not.toContain("stop api");
  } finally { rmSync(t.dir, { recursive: true, force: true }); }
});

test("restore also refuses when uploads already exist, even with an empty database", () => {
  const t = setup();
  try {
    const target = join(t.dir, "backup");
    expect(run("backup.sh", [target], t.env).code).toBe(0);
    const result = run("restore.sh", [target], { ...t.env, STUB_ENTRIES: "3" });
    expect(result.code).toBe(3);
    expect(t.calls()).not.toContain("pg_restore");
  } finally { rmSync(t.dir, { recursive: true, force: true }); }
});

test("restore with --replace-live-database stops the app, restores, migrates and starts the stack again", () => {
  const t = setup();
  try {
    const target = join(t.dir, "backup");
    expect(run("backup.sh", [target], t.env).code).toBe(0);
    const before = t.calls().length; // the log is append-only, so the new calls start at this offset
    const result = run("restore.sh", [target, "--replace-live-database"], { ...t.env, STUB_TABLES: "42" });
    expect(result.code).toBe(0);
    const calls = t.calls().slice(before);
    expect(calls.indexOf(" build")).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf(" build")).toBeLessThan(calls.indexOf("stop api"));
    expect(calls.indexOf("stop api")).toBeLessThan(calls.indexOf("--single-transaction"));
    expect(calls.indexOf("--single-transaction")).toBeLessThan(calls.indexOf("run --build --rm migrate"));
    expect(calls.indexOf("run --build --rm migrate")).toBeLessThan(calls.indexOf("up -d"));
  } finally { rmSync(t.dir, { recursive: true, force: true }); }
});

test("restore refuses a backup whose files no longer match the checksums", () => {
  const t = setup();
  try {
    const target = join(t.dir, "backup");
    expect(run("backup.sh", [target], t.env).code).toBe(0);
    writeFileSync(join(target, "database.dump"), "TAMPERED");
    const before = t.calls().length; // the log is append-only, so the new calls start at this offset
    const result = run("restore.sh", [target], t.env);
    expect(result.code).toBe(1);
    expect(result.out).toContain("does not match SHA256SUMS");
    expect(t.calls().slice(before)).not.toContain("pg_restore");
  } finally { rmSync(t.dir, { recursive: true, force: true }); }
});

test("restore names the missing file when the folder is not a backup", () => {
  const t = setup();
  try {
    const folder = join(t.dir, "empty");
    expect(Bun.spawnSync(["mkdir", "-p", folder]).exitCode).toBe(0);
    const result = run("restore.sh", [folder], t.env);
    expect(result.code).toBe(1);
    expect(result.out).toContain("database.dump is missing");
    expect(existsSync(join(folder, "SHA256SUMS"))).toBe(false);
  } finally { rmSync(t.dir, { recursive: true, force: true }); }
});

test("backup and restore stop when the file store volume does not exist, instead of using an empty one", () => {
  const { dir, env } = setup();
  const backup = run("backup.sh", [join(dir, "out")], { ...env, STUB_NO_VOLUME: "1" });
  expect(backup.code).toBe(1);
  expect(backup.out).toContain("does not exist");
  expect(existsSync(join(dir, "out"))).toBe(false);
});

test("a started stack with no people or work items in it can be restored without the replace flag", () => {
  const first = setup();
  expect(run("backup.sh", [join(first.dir, "b")], first.env).code).toBe(0);
  // Tables exist (the migrate service made them) but hold no rows: the stub answers 0 to the row count.
  const fresh = run("restore.sh", [join(first.dir, "b")], { ...first.env, STUB_TABLES: "0" });
  expect(fresh.code).toBe(0);
  expect(fresh.out).not.toContain("live database was saved");
  expect(readdirSync(join(first.dir, "pre-restore"))).toEqual([]);
});

test("a live database is saved to the backups folder as a readable dump before it is replaced", () => {
  const t = setup();
  try {
    expect(run("backup.sh", [join(t.dir, "b")], t.env).code).toBe(0);
    expect(run("restore.sh", [join(t.dir, "b"), "--replace-live-database"], { ...t.env, STUB_TABLES: "42" }).code).toBe(0);
    const saved = readdirSync(join(t.dir, "pre-restore")).filter((f) => f.endsWith(".dump"));
    expect(saved.length).toBe(1);
    expect(readFileSync(join(t.dir, "pre-restore", saved[0]!), "utf8")).toBe("DUMP-BYTES\n");
  } finally { rmSync(t.dir, { recursive: true, force: true }); }
});

test("a failure after the database was replaced tells the operator not to start the stack, and never starts it", () => {
  const t = setup();
  try {
    expect(run("backup.sh", [join(t.dir, "b")], t.env).code).toBe(0);
    const before = t.calls().length;
    const early = run("restore.sh", [join(t.dir, "b"), "--replace-live-database"], { ...t.env, STUB_TABLES: "42", STUB_FAIL_PSQL: "1" });
    expect(early.code).not.toBe(0);
    expect(early.out).toContain("the database was not replaced");
    expect(t.calls().slice(before)).not.toContain("up -d");
    const mid = t.calls().length;
    const late = run("restore.sh", [join(t.dir, "b"), "--replace-live-database"], { ...t.env, STUB_TABLES: "42", STUB_FAIL_MIGRATE: "1" });
    expect(late.code).not.toBe(0);
    expect(late.out).toContain("Do NOT start the stack yet");
    expect(late.out).toContain("--replace-live-database");
    expect(late.out.split("Do NOT start the stack yet").length - 1).toBe(1);
    expect(t.calls().slice(mid)).not.toContain("up -d");
  } finally { rmSync(t.dir, { recursive: true, force: true }); }
});

test("a stack running with compose.proxy.yaml is not restored by a command that would start it without that file; one that includes it is", () => {
  const t = setup();
  try {
    expect(run("backup.sh", [join(t.dir, "b")], t.env).code).toBe(0);
    const proxyStack = { ...t.env, STUB_CONFIG_FILES: "/srv/weft/compose.yaml,/srv/weft/compose.proxy.yaml" };
    const before = t.calls().length;
    const refused = run("restore.sh", [join(t.dir, "b")], proxyStack);
    expect(refused.code).toBe(2);
    expect(refused.out).toContain("compose.proxy.yaml");
    expect(t.calls().slice(before)).not.toContain("stop api");
    const allowed = run("restore.sh", [join(t.dir, "b")], { ...proxyStack, STUB_SERVICES: "api\nweb\ncaddy" });
    expect(allowed.code).toBe(0);
  } finally { rmSync(t.dir, { recursive: true, force: true }); }
});

test("the live-data check ignores the file store's own bucket folder and .minio.sys, so a freshly started stack restores without the flag", () => {
  const t = setup();
  try {
    const target = join(t.dir, "backup");
    expect(run("backup.sh", [target], t.env).code).toBe(0);
    const before = t.calls().length;
    expect(run("restore.sh", [target], t.env).code).toBe(0);
    const calls = t.calls().slice(before);
    expect(calls).toContain("find /data -type f -not -path '/data/.minio.sys/*'");
    expect(calls).not.toContain("ls -A");
  } finally { rmSync(t.dir, { recursive: true, force: true }); }
});

test("replacing a live instance copies the live uploads too, drops old schemas and restores in one transaction", () => {
  const t = setup();
  try {
    const target = join(t.dir, "backup");
    expect(run("backup.sh", [target], t.env).code).toBe(0);
    const before = t.calls().length;
    const result = run("restore.sh", [target, "--replace-live-database"], { ...t.env, STUB_TABLES: "42", STUB_ENTRIES: "3" });
    expect(result.code).toBe(0);
    const calls = t.calls().slice(before);
    expect(result.out).toContain("live uploads were saved to ");
    expect(calls.indexOf("stop api")).toBeLessThan(calls.indexOf("-czf /out/pre-restore-"));
    expect(calls.indexOf("-czf /out/pre-restore-")).toBeLessThan(calls.indexOf("-delete"));
    expect(calls).toContain("drop schema if exists public cascade");
    expect(calls).toContain("--single-transaction");
    expect(calls.indexOf("stop api")).toBeLessThan(calls.indexOf("pg_restore -f /dev/null"));
    expect(calls.indexOf("pg_restore -f /dev/null")).toBeLessThan(calls.indexOf("-delete"));
    expect(existsSync(join(t.dir, "pre-restore"))).toBe(true);
  } finally { rmSync(t.dir, { recursive: true, force: true }); }
});

test("a safety dump that cannot be read back stops the restore before anything is dropped or deleted", () => {
  const t = setup();
  try {
    const target = join(t.dir, "backup");
    expect(run("backup.sh", [target], t.env).code).toBe(0);
    const before = t.calls().length;
    const result = run("restore.sh", [target, "--replace-live-database"], { ...t.env, STUB_TABLES: "42", STUB_BAD_DUMP: "1" });
    expect(result.code).toBe(1);
    expect(result.out).toContain("could not be read back");
    const calls = t.calls().slice(before);
    expect(calls).not.toContain("drop schema");
    expect(calls).not.toContain("-delete");
  } finally { rmSync(t.dir, { recursive: true, force: true }); }
});

test("the live-uploads check finds real files and ignores the file store's own folders", () => {
  const dir = mkdtempSync(join(tmpdir(), "weft-find-"));
  try {
    const script = readFileSync(join(import.meta.dir, "restore.sh"), "utf8");
    const line = script.split("\n").find((l) => l.startsWith("entries="))!;
    const command = /sh -c "(find [^"]+)"/.exec(line)![1]!.replaceAll("/data", dir);
    Bun.spawnSync(["sh", "-c", `mkdir -p ${dir}/.minio.sys ${dir}/weft-assets && echo x > ${dir}/.minio.sys/format.json`]);
    const count = () => Bun.spawnSync(["sh", "-c", command]).stdout.toString().trim();
    expect(count()).toBe("0");
    Bun.spawnSync(["sh", "-c", `mkdir -p ${dir}/weft-assets/a && echo x > ${dir}/weft-assets/a/xl.meta`]);
    expect(count()).toBe("1");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("restore.sh declares its setup, error trap and proxy guard exactly once", () => {
  const script = readFileSync(join(import.meta.dir, "restore.sh"), "utf8");
  expect(script.match(/^trap on_error ERR$/gm)?.length).toBe(1);
  expect(script.match(/^repo_root=/gm)?.length).toBe(1);
  expect(script.match(/compose\.proxy\.yaml\*/g)?.length).toBe(1);
});

test("a failing image build stops the restore before the stack is stopped or anything is replaced", () => {
  const t = setup();
  try {
    expect(run("backup.sh", [join(t.dir, "b")], t.env).code).toBe(0);
    const before = t.calls().length;
    const result = run("restore.sh", [join(t.dir, "b"), "--replace-live-database"], { ...t.env, STUB_TABLES: "42", STUB_FAIL_BUILD: "1" });
    expect(result.code).not.toBe(0);
    expect(result.out).toContain("the database was not replaced");
    const calls = t.calls().slice(before);
    expect(calls).not.toContain("stop api");
    expect(calls).not.toContain("--single-transaction");
  } finally { rmSync(t.dir, { recursive: true, force: true }); }
});
