import { lt } from "drizzle-orm";
import { workItemIntegrationDeliveries, type Database } from "@weft/db";

/** Delivery ids older than this are forgotten; a provider does not redeliver after that long. */
export const deliveryRetentionMs = 30 * 24 * 60 * 60 * 1000;

/** Drops delivery records older than the retention window. Runs from the hourly cleanup. */
export async function purgeIntegrationDeliveries(database: Database, now: Date = new Date()) {
  await database.delete(workItemIntegrationDeliveries).where(lt(workItemIntegrationDeliveries.receivedAt, new Date(now.getTime() - deliveryRetentionMs)));
}
