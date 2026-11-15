import { migrate } from "drizzle-orm/postgres-js/migrator";
import { sql } from "drizzle-orm";
import { createDatabase, getWikiPageScopeMigrationReport, type Database } from "@weft/db";
import { backfillRichText, RichTextBackfillError } from "./rich-text-backfill";

const { client, db } = createDatabase();
const dryRun = Bun.argv.includes("--dry-run");
// --schema-only applies the SQL migrations and stops: no backfill, so the read-only --dry-run can follow it.
const schemaOnly = Bun.argv.includes("--schema-only");
try {
  if (dryRun && schemaOnly) throw new Error("Use --schema-only or --dry-run, not both.");
  if (dryRun) {
    const [ready] = await db.execute<{ ready: boolean }>(sql`select to_regclass('public.rich_text_backfill_state') is not null as ready`);
    if (!ready?.ready) throw new Error("Apply the schema first with `bun run db:migrate --schema-only`, then run the read-only rich-text dry run.");
  }
  const [wikiTable] = await db.execute<{ ready: boolean }>(sql`select to_regclass('public.wiki_pages') is not null as ready`);
  if (wikiTable?.ready) {
    const [legacyTable] = await db.execute<{ ready: boolean }>(sql`select to_regclass('public.wiki_page_projects') is not null as ready`);
    if (legacyTable?.ready) {
      const [linkCount] = await db.execute<{ value: string }>(sql`select count(*)::text as value from wiki_page_projects`);
      const report = await getWikiPageScopeMigrationReport(db);
      if (Number(linkCount?.value ?? 0) > 0 || report.copies > 0 || report.scopeChanges > 0) {
        throw new Error(`Wiki Page data needs migration first: ${JSON.stringify(report)}. Run bun run db:migrate:wiki-pages -- --dry-run, review the counts, then rerun with --apply.`);
      }
    }
  }
  if (!dryRun) await migrate(db, { migrationsFolder: new URL("../../../db/migrations", import.meta.url).pathname });
  if (schemaOnly) { console.log("Schema migrations applied; the Written form backfill was not run"); await client.end(); process.exit(0); }
  // Rows are converted outside any transaction; only the writes run in one short transaction.
  const report = await backfillRichText(db, { dryRun, withTransaction: (run) => db.transaction((transaction) => run(transaction as unknown as Database)) });
  console.log(`Written form backfill ${dryRun ? "dry run" : "applied"}: ${JSON.stringify(report.counts)}`);
  console.log(`Written form backfill took ${report.seconds.toFixed(1)} s for ${report.rows} row(s); ${report.writeSeconds.toFixed(1)} s inside the write transaction; ${report.outlinks.workItems + report.outlinks.pages} outlink source(s) rebuilt after the commit in ${report.outlinks.seconds.toFixed(1)} s; ${report.degraded.length} degraded and ${report.warnings.filter(({ code }) => code === "slow-conversion").length} slow row(s) listed below.`);
  for (const warning of report.warnings) console.warn(`${warning.table} ${warning.id}: ${warning.code}: ${warning.message}`);
  for (const row of report.degraded) console.warn(`${row.table} ${row.id}: stored as plain text, legacy columns kept: ${row.reason}`);
  if (report.failures.length) {
    for (const failure of report.failures) console.error(`${failure.table} ${failure.id}: ${failure.reason}`);
    process.exitCode = 1;
  } else if (dryRun) console.log("Dry run complete; no data rows were written.");
  else console.log("Database migrations applied");
} catch (error) {
  if (error instanceof RichTextBackfillError) {
    console.error(error.message);
    process.exitCode = 1;
  } else {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
} finally {
  await client.end();
}
