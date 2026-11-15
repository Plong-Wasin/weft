import { expect, test } from "bun:test";
import { SQL } from "bun";

// `db:migrate --schema-only` applies the SQL migrations only (no backfill); the read-only `--dry-run` can then follow it.
const run = new URL("../src/migrations/run.ts", import.meta.url).pathname;
async function migrate(url: string, ...args: string[]) {
  const child = Bun.spawn(["bun", run, ...args], { env: { ...process.env, DATABASE_URL: url }, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { out: out + err, code };
}

test("--schema-only applies the migrations without the backfill, then --dry-run works and a plain run backfills", async () => {
  const admin = new URL(process.env.DATABASE_URL!);
  const name = `weft_schema_only_${Date.now()}`;
  admin.pathname = "/postgres";
  const adminDb = new SQL(admin.toString());
  await adminDb.unsafe(`create database ${name}`);
  const scratch = new URL(process.env.DATABASE_URL!);
  scratch.pathname = `/${name}`;
  try {
    // A dry run before any schema exists says what to do first.
    const early = await migrate(scratch.toString(), "--dry-run");
    expect(early.code).not.toBe(0);
    expect(early.out).toContain("--schema-only");
    const schema = await migrate(scratch.toString(), "--schema-only");
    expect(schema.code).toBe(0);
    expect(schema.out).toContain("Schema migrations applied");
    expect(schema.out).not.toContain("Written form backfill applied");
    const db = new SQL(scratch.toString());
    const state = await db.unsafe(`select count(*)::int as n from rich_text_backfill_state where key = 'written-form-v1'`);
    expect(state[0].n).toBe(0);
    expect((await db.unsafe(`select to_regclass('public.outlinks') is not null as ok`))[0].ok).toBe(true);
    await db.close();
    const dry = await migrate(scratch.toString(), "--dry-run");
    expect(dry.code).toBe(0);
    expect(dry.out).toContain("Dry run complete");
    const full = await migrate(scratch.toString());
    expect(full.code).toBe(0);
    expect(full.out).toContain("Written form backfill applied");
  } finally {
    await adminDb.unsafe(`drop database ${name} with (force)`);
    await adminDb.close();
  }
}, 120_000);
