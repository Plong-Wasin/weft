import { type SQL } from "drizzle-orm";
import { liveWorkItems } from "./triage";

/**
 * The one condition every work item read shares: not soft-deleted and not in the Triage state
 * (see `liveWorkItems` in triage.ts). List, search and PQL all go through it.
 */
export function listableWorkItem(): SQL {
  return liveWorkItems;
}
