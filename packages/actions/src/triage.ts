import { and, inArray, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import type { Database } from "@weft/db";
import { workItems } from "@weft/db";
import { ActionError } from "./members";

/** The state group of the one system Triage state every project has. Users cannot add, rename, reorder, or remove it. */
export const triageGroup = "triage";
export const triageStateName = "Triage";

/**
 * The single definition of "this work item is not waiting in Intake". Every read of work items must apply it:
 * a work item in the Triage state group stays out of lists, boards, search, Cycles, Modules, and every other result until it is accepted.
 * `stateIdColumn` is the SQL for the work item's state_id (an aliased column in raw queries).
 */
export function notInTriageFor(stateIdColumn: SQL): SQL {
  return sql`not exists (select 1 from work_item_states triage_state where triage_state.id = ${stateIdColumn} and triage_state.state_group = ${triageGroup})`;
}

export const notInTriage = notInTriageFor(sql`${workItems.stateId}`);

/** Work items a normal read may return: not soft-deleted and not in Triage. Intake Actions use their own queries. */
export const liveWorkItems = and(isNull(workItems.deletedAt), notInTriage)!;

/** Work items that are live and not archived: what lists, search, PQL, Cycle and Module contents and counts return by default. */
export const unarchivedWorkItems = and(liveWorkItems, isNull(workItems.archivedAt))!;

/** Every write on a work item (fields, state, comments, links, relations, sub-items) goes through this; restore is the only write that skips it. */
export function assertNotArchived(item: { archivedAt: Date | null }) {
  if (item.archivedAt) throw new ActionError("Work item is archived", 400);
}

/** Refuses when any of these work items is archived (membership of a Cycle or Module is a write on the work item). */
export async function assertNoneArchived(database: Database, ids: string[]) {
  const [archived] = await database.select({ id: workItems.id }).from(workItems).where(and(inArray(workItems.id, ids), isNotNull(workItems.archivedAt))).limit(1);
  if (archived) throw new ActionError("Work item is archived", 400);
}
