import { sql } from "drizzle-orm";
import { createDatabase } from "./index";
import { migrateWikiPageScopes } from "./wiki-page-scope-migration";

const apply = Bun.argv.includes("--apply");
const { client, db } = createDatabase();
try {
  const [legacyTable] = await db.execute<{ ready: boolean }>(sql`select to_regclass('wiki_page_projects') is not null as ready`);
  const endpoint = Bun.env.S3_ENDPOINT ?? "http://localhost:9000";
  const storage = apply ? new Bun.S3Client({
    endpoint, bucket: Bun.env.S3_BUCKET ?? "weft-assets", region: Bun.env.S3_REGION ?? "us-east-1",
    accessKeyId: Bun.env.S3_ACCESS_KEY ?? "weft", secretAccessKey: Bun.env.S3_SECRET_KEY ?? "weft-secret",
  }) : null;
  const report = await migrateWikiPageScopes(db, !apply, undefined, storage ? async (source, destination) => {
    const bytes = await storage.file(source).arrayBuffer();
    await storage.file(destination).write(bytes);
  } : undefined);
  console.log(`${apply ? "Applied" : legacyTable?.ready ? "Dry run" : "Already migrated"}: ${JSON.stringify(report)}`);
  if (!apply && legacyTable?.ready) console.log("Run with --apply to migrate the reported Pages, then run bun run db:migrate.");
} finally {
  await client.end();
}
