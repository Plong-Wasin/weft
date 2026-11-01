import { afterAll, expect, test } from "bun:test";
import { createDatabase, type Database } from "@weft/db";
import { createProjectActions, createWorkItemActions } from "../src";
import { createMemberFactory, createWorkspaceFactory, withRollback } from "../../db/src/test-helpers";

const { client, db } = createDatabase();
afterAll(async () => client.end());

async function setup(transaction: Database) {
  const workspace = await createWorkspaceFactory(transaction);
  const admin = await createMemberFactory(transaction, workspace.id, "Admin");
  const member = await createMemberFactory(transaction, workspace.id, "Member");
  const other = await createMemberFactory(transaction, workspace.id, "Member");
  const guest = await createMemberFactory(transaction, workspace.id, "Guest");
  const outsider = await createMemberFactory(transaction, (await createWorkspaceFactory(transaction)).id, "Member");
  const projects = createProjectActions(transaction);
  const items = createWorkItemActions(transaction);
  const project = await projects.createProject.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Mobile", key: "MOB", visibility: "public" });
  for (const user of [member, other, guest]) await projects.addProjectMember.handler({ userId: admin.id }, { projectId: project.id, userId: user.id, role: user === guest ? "Guest" : "Member" });
  const create = (input: Record<string, unknown> = {}, userId = member.id) =>
    items.createWorkItem.handler({ userId }, { projectId: project.id, title: "Item", ...input } as never);
  return { workspace, admin, member, other, guest, outsider, items, project, create };
}

test.concurrent("multiple assignees are set, cleared, restricted to project members and logged", async () => {
  await withRollback(db, async (transaction) => {
    const { items, member, other, admin, project, workspace, create } = await setup(transaction);
    const stranger = await createMemberFactory(transaction, workspace.id, "Member");
    const item = await create({ assigneeIds: [member.id, other.id] });
    expect(item.assigneeIds.sort()).toEqual([member.id, other.id].sort());
    await expect(items.updateWorkItem.handler({ userId: member.id }, { workItemId: item.id, assigneeIds: [stranger.id] })).rejects.toMatchObject({ status: 400 });
    const updated = await items.updateWorkItem.handler({ userId: member.id, source: "mcp" }, { workItemId: item.id, assigneeIds: [other.id] });
    expect(updated.assigneeIds).toEqual([other.id]);
    expect(await items.updateWorkItem.handler({ userId: member.id }, { workItemId: item.id, assigneeIds: [] }).then((row) => row.assigneeIds)).toEqual([]);
    const log = await items.listWorkItemActivities.handler({ userId: member.id }, { workItemId: item.id });
    const changes = log.filter((row) => row.field === "assignees");
    expect(changes).toHaveLength(3);
    expect(changes[1]).toMatchObject({ oldValue: [member.id, other.id].sort(), newValue: [other.id], actorId: member.id, source: "mcp" });
    expect((await items.getWorkItem.handler({ userId: admin.id }, { workspaceId: workspace.id, displayId: item.displayId })).assigneeIds).toEqual([]);
    void project;
  });
});

test.concurrent("labels are project-scoped; only project admins manage them; deleting detaches", async () => {
  await withRollback(db, async (transaction) => {
    const { items, admin, member, guest, outsider, project, workspace, create } = await setup(transaction);
    const bug = await items.createLabel.handler({ userId: admin.id }, { projectId: project.id, name: "bug", color: "#ff0000" });
    await expect(items.createLabel.handler({ userId: member.id }, { projectId: project.id, name: "x" })).rejects.toMatchObject({ status: 403 });
    await expect(items.createLabel.handler({ userId: guest.id }, { projectId: project.id, name: "x" })).rejects.toMatchObject({ status: 403 });
    await expect(items.createLabel.handler({ userId: outsider.id }, { projectId: project.id, name: "x" })).rejects.toMatchObject({ status: 403 });
    await expect(items.createLabel.handler({ userId: admin.id }, { projectId: project.id, name: "bug" })).rejects.toMatchObject({ status: 400 });
    await expect(items.updateLabel.handler({ userId: member.id }, { labelId: bug.id, name: "y" })).rejects.toMatchObject({ status: 403 });
    expect((await items.updateLabel.handler({ userId: admin.id }, { labelId: bug.id, name: "defect" })).name).toBe("defect");
    expect((await items.listLabels.handler({ userId: guest.id }, { projectId: project.id })).map((label) => label.name)).toEqual(["defect"]);

    const second = await createProjectActions(transaction).createProject.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Web", key: "WEB", visibility: "public" });
    const foreign = await items.createLabel.handler({ userId: admin.id }, { projectId: second.id, name: "other" });
    const item = await create({ labelIds: [bug.id] });
    expect(item.labelIds).toEqual([bug.id]);
    await expect(items.updateWorkItem.handler({ userId: member.id }, { workItemId: item.id, labelIds: [foreign.id] })).rejects.toMatchObject({ status: 400 });

    await items.deleteLabel.handler({ userId: admin.id }, { labelId: bug.id });
    const after = await items.getWorkItem.handler({ userId: member.id }, { workspaceId: workspace.id, displayId: item.displayId });
    expect(after.labelIds).toEqual([]);
    const log = await items.listWorkItemActivities.handler({ userId: member.id }, { workItemId: item.id });
    expect(log.filter((row) => row.field === "labels").map((row) => row.newValue)).toEqual([[bug.id], []]);
  });
});

test.concurrent("start and due dates are validated and logged", async () => {
  await withRollback(db, async (transaction) => {
    const { items, member, create } = await setup(transaction);
    const item = await create({ startDate: "2026-01-10", dueDate: "2026-01-20" });
    expect(item).toMatchObject({ startDate: "2026-01-10", dueDate: "2026-01-20" });
    await expect(items.updateWorkItem.handler({ userId: member.id }, { workItemId: item.id, dueDate: "2026-01-05" })).rejects.toMatchObject({ status: 400 });
    await expect(items.updateWorkItem.handler({ userId: member.id }, { workItemId: item.id, dueDate: "2026-02-31" })).rejects.toMatchObject({ status: 400 });
    const cleared = await items.updateWorkItem.handler({ userId: member.id }, { workItemId: item.id, dueDate: null });
    expect(cleared.dueDate).toBeNull();
    const log = await items.listWorkItemActivities.handler({ userId: member.id }, { workItemId: item.id });
    expect(log.find((row) => row.field === "dueDate" && row.newValue === null)).toMatchObject({ oldValue: "2026-01-20" });
  });
});

test.concurrent("sub-work items are created under a parent and listed; cycles and foreign parents are rejected", async () => {
  await withRollback(db, async (transaction) => {
    const { items, member, workspace, admin, create } = await setup(transaction);
    const a = await create({ title: "A" });
    const b = await create({ title: "B", parentId: a.id });
    const c = await create({ title: "C", parentId: b.id });
    expect(b.parentId).toBe(a.id);
    expect((await items.listSubWorkItems.handler({ userId: member.id }, { workItemId: a.id })).map((row) => row.id)).toEqual([b.id]);
    await expect(items.updateWorkItem.handler({ userId: member.id }, { workItemId: a.id, parentId: c.id })).rejects.toMatchObject({ status: 400 });
    await expect(items.updateWorkItem.handler({ userId: member.id }, { workItemId: a.id, parentId: a.id })).rejects.toMatchObject({ status: 400 });
    const other = await createProjectActions(transaction).createProject.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Web", key: "WEB", visibility: "public" });
    const foreign = await items.createWorkItem.handler({ userId: admin.id }, { projectId: other.id, title: "F" });
    await expect(items.updateWorkItem.handler({ userId: member.id }, { workItemId: a.id, parentId: foreign.id })).rejects.toMatchObject({ status: 400 });
    const detached = await items.updateWorkItem.handler({ userId: member.id }, { workItemId: c.id, parentId: null });
    expect(detached.parentId).toBeNull();
    const log = await items.listWorkItemActivities.handler({ userId: member.id }, { workItemId: c.id });
    expect(log.filter((row) => row.field === "parent").map((row) => row.newValue)).toEqual([b.id, null]);
  });
});

test.concurrent("Activity rows carry the actor name and source; Guests read but cannot change, outsiders see nothing", async () => {
  await withRollback(db, async (transaction) => {
    const { items, member, guest, outsider, project, create } = await setup(transaction);
    const item = await create({ title: "T" });
    await items.updateWorkItem.handler({ userId: member.id, source: "ai" }, { workItemId: item.id, startDate: "2026-03-01" });
    const log = await items.listWorkItemActivities.handler({ userId: guest.id }, { workItemId: item.id });
    expect(log.at(-1)).toMatchObject({ field: "startDate", actorId: member.id, source: "ai", actorName: "Test user" });
    await expect(items.updateWorkItem.handler({ userId: guest.id }, { workItemId: item.id, assigneeIds: [member.id] })).rejects.toMatchObject({ status: 403 });
    await expect(items.updateWorkItem.handler({ userId: guest.id }, { workItemId: item.id, parentId: null, labelIds: [] })).rejects.toMatchObject({ status: 403 });
    await expect(create({ parentId: item.id }, guest.id)).rejects.toMatchObject({ status: 403 });
    expect(await items.listSubWorkItems.handler({ userId: guest.id }, { workItemId: item.id })).toEqual([]);
    for (const call of [
      () => items.updateWorkItem.handler({ userId: outsider.id }, { workItemId: item.id, startDate: "2026-04-01" }),
      () => items.listWorkItemActivities.handler({ userId: outsider.id }, { workItemId: item.id }),
      () => items.listSubWorkItems.handler({ userId: outsider.id }, { workItemId: item.id }),
      () => items.listLabels.handler({ userId: outsider.id }, { projectId: project.id }),
    ]) await expect(call()).rejects.toMatchObject({ status: 403 });
  });
});
