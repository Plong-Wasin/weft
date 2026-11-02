import { sql } from "drizzle-orm";
import { createDatabase } from "./index";
import { migrateWikiPageScopes } from "./wiki-page-scope-migration";

const apply = Bun.argv.includes("--apply");
const { client, db } = createDatabase();
try {
  const [legacyTable] = await db.execute<{ ready: boolean }>(sql`select to_regclass('wiki_page_projects') is not null as ready`);
  const report = await migrateWikiPageScopes(db, !apply);
  console.log(`${apply ? "Applied" : legacyTable?.ready ? "Dry run" : "Already migrated"}: ${JSON.stringify(report)}`);
  if (!apply && legacyTable?.ready) console.log("Run with --apply to migrate the reported Pages, then run bun run db:migrate.");
} finally {
  await client.end();
}
