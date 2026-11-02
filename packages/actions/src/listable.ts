import { and, isNotNull, type SQL } from "drizzle-orm";
import { workItems } from "@weft/db";
import { liveWorkItems, unarchivedWorkItems } from "./triage";

/**
 * The one condition every work item read shares: not soft-deleted, not in the Triage state and not archived
 * (see `liveWorkItems` and `unarchivedWorkItems` in triage.ts). List, search and PQL all go through it.
 * `archived` flips the archive half: only archived work items.
 */
export function listableWorkItem(options: { archived?: boolean } = {}): SQL {
  return options.archived ? and(liveWorkItems, isNotNull(workItems.archivedAt))! : unarchivedWorkItems;
}
