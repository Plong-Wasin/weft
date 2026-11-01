import { isNull, sql, type SQL } from "drizzle-orm";
import { workItems } from "@weft/db";

/**
 * The one condition every work item read shares: not soft-deleted and, once Intake exists, not in the
 * Triage state. The Intake ticket extends this function so list, search and PQL all pick it up.
 */
export function listableWorkItem(): SQL {
  return sql`${isNull(workItems.deletedAt)}`;
}
