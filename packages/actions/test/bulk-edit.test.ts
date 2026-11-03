import { afterAll, expect, test } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";
import { activities, createDatabase, workspaceMembers, type Database } from "@weft/db";
import { createEstimateActions, createProjectActions, createWorkItemActions, createWorkItemArchiveActions, writeDecision } from "../src";
import { createMemberFactory, createWorkspaceFactory, withRollback } from "../../db/src/test-helpers";

const { client, db } = createDatabase();
afterAll(async () => client.end());

async function setup(transaction: Database) {
  const workspace = await createWorkspaceFactory(transaction);
  const admin = await createMemberFactory(transaction, workspace.id, "Admin");
  const member = await createMemberFactory(transaction, workspace.id, "Member");
  const other = await createMemberFactory(transaction, workspace.id, "Member");
  const guest = await createMemberFactory(transaction, workspace.id, "Guest");
  const projects = createProjectActions(transaction);
  const project = await projects.createProject.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Mobile", key: "MOB", visibility: "private" });
  const elsewhere = await projects.createProject.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Web", key: "WEB", visibility: "private" });
  for (const user of [member, other]) await projects.addProjectMember.handler({ userId: admin.id }, { projectId: project.id, userId: user.id, role: "Member" });
  await projects.addProjectMember.handler({ userId: admin.id }, { projectId: project.id, userId: guest.id, role: "Guest" });
  const work = createWorkItemActions(transaction);
  const archive = createWorkItemArchiveActions(transaction);
  const states = await work.listStates.handler({ userId: member.id }, { projectId: project.id });
  const stateOf = (group: string) => states.find((state) => state.group === group)!.id;
  const as = { userId: member.id };
  const item = (title: string, extra: Record<string, unknown> = {}) => work.createWorkItem.handler(as, { projectId: project.id, title, ...extra } as never);
  const reason = (promise: Promise<unknown>) => promise.then(() => "ok", (error: Error & { status?: number }) => `${error.status} ${error.message}`);
  return { admin, member, other, guest, project, elsewhere, work, archive, stateOf, as, item, reason };
}

test.concurrent("a Bulk edit sets State and Priority on every selected item and links their Activities", async () => {
  await withRollback(db, async (transaction) => {
    const { work, project, as, item, stateOf } = await setup(transaction);
    const a = await item("A"), b = await item("B"), untouched = await item("C");
    const result = await work.bulkUpdateWorkItems.handler(as, { projectId: project.id, workItemIds: [a.id, b.id], stateId: stateOf("started"), priority: "high" });
    expect(result.changed).toBe(2);
    const rows = await work.listWorkItems.handler(as, { projectId: project.id });
    for (const id of [a.id, b.id]) expect(rows.find((row) => row.id === id)).toMatchObject({ stateId: stateOf("started"), priority: "high" });
    expect(rows.find((row) => row.id === untouched.id)!.priority).toBe(untouched.priority);
    const logged = await transaction.select().from(activities).where(and(eq(activities.bulkEditId, result.bulkEditId)));
    expect(logged.map((row) => `${row.entityId}:${row.field}`).sort()).toEqual([a.id, b.id].flatMap((id) => [`${id}:priority`, `${id}:state`]).sort());
    expect((await work.listWorkItemActivities.handler(as, { workItemId: a.id })).filter((row) => row.bulkEditId === result.bulkEditId)).toHaveLength(2);
  });
});

test.concurrent("assignees and labels are added or removed without touching the rest of each item's set", async () => {
  await withRollback(db, async (transaction) => {
    const { work, project, as, item, member, other, admin } = await setup(transaction);
    const bug = await work.createLabel.handler({ userId: admin.id }, { projectId: project.id, name: "bug" });
    const ui = await work.createLabel.handler({ userId: admin.id }, { projectId: project.id, name: "ui" });
    const a = await item("A", { assigneeIds: [member.id], labelIds: [bug.id] }), b = await item("B", { labelIds: [ui.id] });
    await work.bulkUpdateWorkItems.handler(as, { projectId: project.id, workItemIds: [a.id, b.id], addAssigneeIds: [other.id], addLabelIds: [bug.id] });
    let rows = await work.listWorkItems.handler(as, { projectId: project.id });
    expect(rows.find((row) => row.id === a.id)).toMatchObject({ assigneeIds: [member.id, other.id].sort(), labelIds: [bug.id] });
    expect(rows.find((row) => row.id === b.id)).toMatchObject({ assigneeIds: [other.id], labelIds: [bug.id, ui.id].sort() });
    await work.bulkUpdateWorkItems.handler(as, { projectId: project.id, workItemIds: [a.id, b.id], removeAssigneeIds: [member.id], removeLabelIds: [bug.id] });
    rows = await work.listWorkItems.handler(as, { projectId: project.id });
    expect(rows.find((row) => row.id === a.id)).toMatchObject({ assigneeIds: [other.id], labelIds: [] });
    expect(rows.find((row) => row.id === b.id)).toMatchObject({ assigneeIds: [other.id], labelIds: [ui.id] });
  });
});

test.concurrent("one item that cannot take the change stops the whole Bulk edit and is named", async () => {
  await withRollback(db, async (transaction) => {
    const { work, project, as, item, stateOf, archive, reason, admin } = await setup(transaction);
    const outsider = await createMemberFactory(transaction, (await transaction.select().from(workspaceMembers).where(eq(workspaceMembers.userId, admin.id)))[0]!.workspaceId, "Member");
    const a = await item("A"), done = await item("Done", { stateId: stateOf("completed") });
    await archive.archiveWorkItem.handler(as, { workItemId: done.id });
    expect(await reason(work.bulkUpdateWorkItems.handler(as, { projectId: project.id, workItemIds: [a.id, done.id], priority: "urgent" }))).toBe(`400 MOB-${done.sequence}: Work item is archived`);
    expect((await work.listWorkItems.handler(as, { projectId: project.id })).find((row) => row.id === a.id)!.priority).toBe(a.priority);
    // Assignees must be project members, and the refusal names the item too.
    expect(await reason(work.bulkUpdateWorkItems.handler(as, { projectId: project.id, workItemIds: [a.id], addAssigneeIds: [outsider.id] }))).toContain("400 MOB-");
  });
});

test.concurrent("a Bulk edit refuses a Guest, an empty selection, no change, and items of another project", async () => {
  await withRollback(db, async (transaction) => {
    const { work, project, elsewhere, as, item, guest, reason, admin } = await setup(transaction);
    const a = await item("A");
    const foreign = await work.createWorkItem.handler({ userId: admin.id }, { projectId: elsewhere.id, title: "Foreign" });
    expect(await reason(work.bulkUpdateWorkItems.handler({ userId: guest.id }, { projectId: project.id, workItemIds: [a.id], priority: "low" }))).toStartWith("403");
    expect(await reason(work.bulkUpdateWorkItems.handler(as, { projectId: project.id, workItemIds: [], priority: "low" }))).toStartWith("400");
    expect(await reason(work.bulkUpdateWorkItems.handler(as, { projectId: project.id, workItemIds: [a.id] }))).toBe("400 Nothing to change");
    expect(await reason(work.bulkUpdateWorkItems.handler(as, { projectId: project.id, workItemIds: [a.id, foreign.id], priority: "low" }))).toStartWith("400");
    expect(await reason(work.deleteWorkItems.handler({ userId: guest.id }, { projectId: project.id, workItemIds: [a.id] }))).toStartWith("403");
  });
});

test.concurrent("bulk archive archives only when every item may be archived", async () => {
  await withRollback(db, async (transaction) => {
    const { work, project, as, item, stateOf, archive, reason } = await setup(transaction);
    const done = await item("Done", { stateId: stateOf("completed") }), cancelled = await item("Cancelled", { stateId: stateOf("cancelled") }), open = await item("Open");
    expect(await reason(archive.bulkArchiveWorkItems.handler(as, { projectId: project.id, workItemIds: [done.id, open.id] }))).toBe(`400 MOB-${open.sequence}: Only a completed or cancelled work item can be archived`);
    expect((await work.listWorkItems.handler(as, { projectId: project.id })).length).toBe(3);
    const result = await archive.bulkArchiveWorkItems.handler(as, { projectId: project.id, workItemIds: [done.id, cancelled.id] });
    expect(result.archived).toBe(2);
    expect((await work.listWorkItems.handler(as, { projectId: project.id })).map((row) => row.id)).toEqual([open.id]);
    const logged = await transaction.select().from(activities).where(and(eq(activities.bulkEditId, result.bulkEditId), inArray(activities.entityId, [done.id, cancelled.id])));
    expect(logged.map((row) => row.field)).toEqual(["archived", "archived"]);
  });
});

test.concurrent("bulk delete removes every selected item, all or none, and always needs a Confirmation from the AI", async () => {
  await withRollback(db, async (transaction) => {
    const { work, project, as, item, stateOf, archive, reason } = await setup(transaction);
    const a = await item("A"), b = await item("B"), done = await item("Done", { stateId: stateOf("completed") });
    await archive.archiveWorkItem.handler(as, { workItemId: done.id });
    expect(await reason(work.deleteWorkItems.handler(as, { projectId: project.id, workItemIds: [a.id, done.id] }))).toContain("archived");
    expect((await work.listWorkItems.handler(as, { projectId: project.id })).length).toBe(2);
    const result = await work.deleteWorkItems.handler(as, { projectId: project.id, workItemIds: [a.id, b.id] });
    expect(result.removed).toBe(2);
    expect(await work.listWorkItems.handler(as, { projectId: project.id })).toEqual([]);
    expect((await transaction.select().from(activities).where(eq(activities.bulkEditId, result.bulkEditId))).map((row) => row.field)).toEqual(["deleted", "deleted"]);
    expect(writeDecision("delete_work_items", true)).toBe("confirmation");
    expect(writeDecision("bulk_update_work_items", false)).toBe("confirmation");
    expect(writeDecision("bulk_update_work_items", true)).toBe("run");
  });
});

test.concurrent("a Bulk edit sets Estimate and dates, counts only items that changed, and names the item whose dates would clash", async () => {
  await withRollback(db, async (transaction) => {
    const { work, project, as, item, reason, admin } = await setup(transaction);
    const estimate = await createEstimateActions(transaction).createEstimate.handler({ userId: admin.id }, { projectId: project.id, type: "points", values: ["1", "2", "3"] });
    const a = await item("A"), b = await item("B", { dueDate: "2030-01-05" });
    const first = await work.bulkUpdateWorkItems.handler(as, { projectId: project.id, workItemIds: [a.id, a.id, b.id], estimatePointId: estimate.points[1]!.id, priority: "low" });
    expect(first.workItemIds.length).toBe(2);
    const rows = await work.listWorkItems.handler(as, { projectId: project.id });
    for (const row of rows) expect(row.estimatePointId).toBe(estimate.points[1]!.id);
    // The same change again touches nothing.
    expect((await work.bulkUpdateWorkItems.handler(as, { projectId: project.id, workItemIds: [a.id, b.id], estimatePointId: estimate.points[1]!.id, priority: "low" })).changed).toBe(0);
    // A start date after B's due date stops the whole edit and names B.
    expect(await reason(work.bulkUpdateWorkItems.handler(as, { projectId: project.id, workItemIds: [a.id, b.id], startDate: "2030-02-01" }))).toBe(`400 MOB-${b.sequence}: Start date must not be after due date`);
    expect((await work.listWorkItems.handler(as, { projectId: project.id })).every((row) => row.startDate === null)).toBe(true);
    expect((await work.bulkUpdateWorkItems.handler(as, { projectId: project.id, workItemIds: [a.id, b.id], estimatePointId: null })).changed).toBe(2);
  });
});
