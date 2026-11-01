import postgres from "postgres";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "./schema";

export type Database = PostgresJsDatabase<typeof schema>;
export { schema };
export * from "./schema";
export * from "./secrets";
import { isProduction, isWeakSecret } from "./secrets";

/** In production the database password must not be the development default. */
function checkProductionUrl(url: string) {
  if (!isProduction()) return;
  const password = (() => { try { return decodeURIComponent(new URL(url).password); } catch { return ""; } })();
  if (isWeakSecret(password)) throw new Error("DATABASE_URL (POSTGRES_PASSWORD) is unset or still a default or placeholder value. Set a strong password before running in production.");
}

export function createDatabase(url = Bun.env.DATABASE_URL ?? "postgres://weft:weft@localhost:54329/weft") {
  checkProductionUrl(url);
  const client = postgres(url, { max: 10 });
  return { client, db: drizzle(client, { schema }) };
}

/** A dedicated connection that LISTENs on a Postgres channel (survives reconnects) and can NOTIFY on it. */
export function createListener(url = Bun.env.DATABASE_URL ?? "postgres://weft:weft@localhost:54329/weft") {
  const client = postgres(url, { max: 2 });
  return {
    listen: (channel: string, onMessage: (payload: string) => void) => client.listen(channel, onMessage),
    notify: (channel: string, payload: string) => client.notify(channel, payload),
    close: () => client.end(),
  };
}
