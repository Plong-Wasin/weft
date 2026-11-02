import { createDatabase } from "@weft/db";
import { createAuth } from "../../api/src/auth";
import { createLiveServer, migrateExistingWikiDocuments } from "./server";

const { client, db } = createDatabase();
const auth = createAuth(db, async () => false);
const live = createLiveServer({
  db,
  port: Number(Bun.env.LIVE_PORT ?? 3001),
  address: Bun.env.LIVE_ADDRESS ?? "0.0.0.0",
  authenticate: async (_token, headers) => (await auth.api.getSession({ headers }))?.user.id ?? null,
});
await migrateExistingWikiDocuments(db);
await live.listen();
console.log(`Weft live server listening at ${live.url}`);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { void live.destroy().finally(() => client.end()); });
