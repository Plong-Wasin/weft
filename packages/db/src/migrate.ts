import { migrate } from "drizzle-orm/postgres-js/migrator";
import { sql } from "drizzle-orm";
import { createDatabase } from "./index";
import { getWikiPageScopeMigrationReport } from "./wiki-page-scope-migration";

const { client, db } = createDatabase();
try {
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
  await migrate(db, { migrationsFolder: new URL("../migrations", import.meta.url).pathname });
  console.log("Database migrations applied");
} finally {
  await client.end();
}
