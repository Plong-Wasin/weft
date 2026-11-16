import { and, asc, eq } from "drizzle-orm";
import type { Database } from "@weft/db";
import { projects, triggers, workItemStates, workItems } from "@weft/db";
import { liveWorkItems } from "./triage";

const closedLabel: Record<string, string> = { completed: "Done", cancelled: "Cancelled" };
const maxListed = 50;

/**
 * The part of a "sub-items closed" Trigger Run's prompt that says which parent and which sub-items closed.
 * Returns null for any other Run. The titles are workspace text, so they sit between markers carrying the random `boundary` id.
 */
export async function subItemsClosedBlock(database: Database, run: { workItemId: string | null; triggerId: string | null }, boundary: string): Promise<string | null> {
  if (!run.workItemId || !run.triggerId) return null;
  const [trigger] = await database.select({ eventType: triggers.eventType }).from(triggers).where(eq(triggers.id, run.triggerId));
  if (trigger?.eventType !== "sub_items_closed") return null;
  const [parent] = await database.select({ title: workItems.title, sequence: workItems.sequence, key: projects.key }).from(workItems).innerJoin(projects, eq(projects.id, workItems.projectId)).where(eq(workItems.id, run.workItemId));
  if (!parent) return null;
  const children = await database.select({ title: workItems.title, sequence: workItems.sequence, group: workItemStates.group, state: workItemStates.name }).from(workItems)
    .innerJoin(workItemStates, eq(workItemStates.id, workItems.stateId)).where(and(eq(workItems.parentId, run.workItemId), liveWorkItems)).orderBy(asc(workItems.sequence));
  const lines = children.slice(0, maxListed).map((child) => `${parent.key}-${child.sequence} ${closedLabel[child.group] ?? child.state}: ${child.title}`);
  const more = children.length > maxListed ? `\n${children.length - maxListed} more sub-items are not listed.` : "";
  return `All sub-items of this work item are now closed (Done or Cancelled), so you were woken as its assignee. Summarise the results of the sub-items below, using your instructions, then reply with your answer.\nParent: ${parent.key}-${parent.sequence}\n<sub_items id="${boundary}">\n${lines.join("\n")}\n</sub_items id="${boundary}">${more}`;
}
