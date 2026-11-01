import postgres from "postgres";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "./schema";

export type Database = PostgresJsDatabase<typeof schema>;
export { schema };
export * from "./schema";

export function createDatabase(url = Bun.env.DATABASE_URL ?? "postgres://weft:weft@localhost:54329/weft") {
  const client = postgres(url, { max: 10 });
  return { client, db: drizzle(client, { schema }) };
}
