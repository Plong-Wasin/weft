import { and, isNull, sql, type SQL } from "drizzle-orm";
import { workItems } from "@weft/db";

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
