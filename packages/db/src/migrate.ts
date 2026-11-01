import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDatabase } from "./index";

const { client, db } = createDatabase();
try {
  await migrate(db, { migrationsFolder: new URL("../migrations", import.meta.url).pathname });
  console.log("Database migrations applied");
} finally {
  await client.end();
}
