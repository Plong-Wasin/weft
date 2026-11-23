import { afterAll, expect, test } from "bun:test";
import { createDatabase, type Database } from "@weft/db";
import { createMemberFactory, createWorkspaceFactory, withRollback } from "../../db/src/test-helpers";
import { createProjectActions, createWorkItemActions, createWorkItemTypeActions } from "../src";

const { client, db } = createDatabase();
afterAll(async () => client.end());

async function setup(transaction: Database) {
  const workspace = await createWorkspaceFactory(transaction);
  const admin = await createMemberFactory(transaction, workspace.id, "Admin");
  const member = await createMemberFactory(transaction, workspace.id, "Member");
  const projects = createProjectActions(transaction);
  const project = await projects.createProject.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Mobile", key: "MOB", visibility: "private" });
  await projects.addProjectMember.handler({ userId: admin.id }, { projectId: project.id, userId: member.id, role: "Member" });
  await projects.setProjectFeatures.handler({ userId: admin.id }, { projectId: project.id, features: { types: true } });
  return { admin, member, project, items: createWorkItemActions(transaction), types: createWorkItemTypeActions(transaction) };
}

const status = (promise: Promise<unknown>) => promise.then(() => 200, (error: { status: number }) => error.status);

test.concurrent("reorder_labels stores the order that list_labels returns, and a new label goes last", async () => {
  await withRollback(db, async (transaction) => {
    const { admin, project, items } = await setup(transaction);
    const ids: Record<string, string> = {};
    for (const name of ["Alpha", "Bravo", "Charlie"]) ids[name] = (await items.createLabel.handler({ userId: admin.id }, { projectId: project.id, name })).id;
    expect((await items.listLabels.handler({ userId: admin.id }, { projectId: project.id })).map((label) => label.name)).toEqual(["Alpha", "Bravo", "Charlie"]);
    await items.reorderLabels.handler({ userId: admin.id }, { projectId: project.id, labelIds: [ids.Charlie!, ids.Alpha!, ids.Bravo!] });
    expect((await items.listLabels.handler({ userId: admin.id }, { projectId: project.id })).map((label) => label.name)).toEqual(["Charlie", "Alpha", "Bravo"]);
    await items.createLabel.handler({ userId: admin.id }, { projectId: project.id, name: "Aardvark" });
    expect((await items.listLabels.handler({ userId: admin.id }, { projectId: project.id })).map((label) => label.name)).toEqual(["Charlie", "Alpha", "Bravo", "Aardvark"]);
  });
});

test.concurrent("reorder_labels refuses a list that is not every label exactly once, and a Member", async () => {
  await withRollback(db, async (transaction) => {
    const { admin, member, project, items } = await setup(transaction);
    const a = (await items.createLabel.handler({ userId: admin.id }, { projectId: project.id, name: "Alpha" })).id;
    const b = (await items.createLabel.handler({ userId: admin.id }, { projectId: project.id, name: "Bravo" })).id;
    expect(await status(items.reorderLabels.handler({ userId: admin.id }, { projectId: project.id, labelIds: [a] }))).toBe(400);
    expect(await status(items.reorderLabels.handler({ userId: admin.id }, { projectId: project.id, labelIds: [a, a] }))).toBe(400);
    expect(await status(items.reorderLabels.handler({ userId: member.id }, { projectId: project.id, labelIds: [b, a] }))).toBe(403);
    expect((await items.listLabels.handler({ userId: admin.id }, { projectId: project.id })).map((label) => label.name)).toEqual(["Alpha", "Bravo"]);
  });
});

test.concurrent("reorder_work_item_types stores the order that list_work_item_types returns", async () => {
  await withRollback(db, async (transaction) => {
    const { admin, project, types } = await setup(transaction);
    const bug = await types.createWorkItemType.handler({ userId: admin.id }, { projectId: project.id, name: "Bug", icon: "task", color: "#dc2626" });
    const request = await types.createWorkItemType.handler({ userId: admin.id }, { projectId: project.id, name: "Request", icon: "task", color: "#2563eb" });
    const task = (await types.listWorkItemTypes.handler({ userId: admin.id }, { projectId: project.id })).find((type) => type.name === "Task")!;
    await types.reorderWorkItemTypes.handler({ userId: admin.id }, { projectId: project.id, typeIds: [request.id, bug.id, task.id] });
    expect((await types.listWorkItemTypes.handler({ userId: admin.id }, { projectId: project.id })).map((type) => type.name)).toEqual(["Request", "Bug", "Task"]);
    expect(await status(types.reorderWorkItemTypes.handler({ userId: admin.id }, { projectId: project.id, typeIds: [request.id, bug.id] }))).toBe(400);
  });
});

test.concurrent("reorder_custom_properties stores the order that list_custom_properties returns", async () => {
  await withRollback(db, async (transaction) => {
    const { admin, project, types } = await setup(transaction);
    const task = (await types.listWorkItemTypes.handler({ userId: admin.id }, { projectId: project.id }))[0]!;
    const first = await types.createCustomProperty.handler({ userId: admin.id }, { projectId: project.id, name: "Area", kind: "text", typeIds: [task.id] });
    const second = await types.createCustomProperty.handler({ userId: admin.id }, { projectId: project.id, name: "Owner team", kind: "text", typeIds: [task.id] });
    await types.reorderCustomProperties.handler({ userId: admin.id }, { projectId: project.id, propertyIds: [second.id, first.id] });
    expect((await types.listCustomProperties.handler({ userId: admin.id }, { projectId: project.id })).map((property) => property.name)).toEqual(["Owner team", "Area"]);
    expect(await status(types.reorderCustomProperties.handler({ userId: admin.id }, { projectId: project.id, propertyIds: [first.id] }))).toBe(400);
  });
});
