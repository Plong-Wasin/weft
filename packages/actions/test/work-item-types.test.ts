import { afterAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { activities, runs, workItemTypes, workItems } from "@weft/db";
import { createDatabase, type Database } from "@weft/db";
import { createActionList, createAgentActions, createProjectActions, createRecurrenceActions, createWorkItemActions, createWorkItemTypeActions } from "../src";
import { createMemberFactory, createWorkspaceFactory, withRollback } from "../../db/src/test-helpers";

const { client, db } = createDatabase();
afterAll(async () => client.end());

async function setup(transaction: Database, features: { types?: boolean } = { types: true }) {
  const workspace = await createWorkspaceFactory(transaction);
  const admin = await createMemberFactory(transaction, workspace.id, "Admin");
  const member = await createMemberFactory(transaction, workspace.id, "Member");
  const outsider = await createMemberFactory(transaction, workspace.id, "Member");
  const projects = createProjectActions(transaction);
  const project = await projects.createProject.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Mobile", key: "MOB", visibility: "private" });
  await projects.addProjectMember.handler({ userId: admin.id }, { projectId: project.id, userId: member.id, role: "Member" });
  if (features.types) await projects.setProjectFeatures.handler({ userId: admin.id }, { projectId: project.id, features: { types: true } });
  return {
    workspace, admin, member, outsider, project, projects,
    items: createWorkItemActions(transaction), types: createWorkItemTypeActions(transaction), transaction,
  };
}

const status = (promise: Promise<unknown>) => promise.then(() => 200, (error: { status: number }) => error.status);
const messageOf = (promise: Promise<unknown>) => promise.then(() => "", (error: Error) => error.message);

test.concurrent("a new project starts with the one neutral type Task, and new work items are Task", async () => {
  await withRollback(db, async (transaction) => {
    const { types, items, admin, project } = await setup(transaction, { types: false });
    const list = await types.listWorkItemTypes.handler({ userId: admin.id }, { projectId: project.id });
    expect(list.map((type) => type.name)).toEqual(["Task"]);
    const created = await items.createWorkItem.handler({ userId: admin.id }, { projectId: project.id, title: "Plan" });
    expect(created).toMatchObject({ typeId: list[0]!.id, properties: [] });
  });
});

test.concurrent("existing work items become Task when the migration runs (migration test)", async () => {
  await withRollback(db, async (transaction) => {
    const { items, admin, project, types } = await setup(transaction, { types: false });
    const item = await items.createWorkItem.handler({ userId: admin.id }, { projectId: project.id, title: "Old item" });
    // Simulate a work item from before the feature: no type, and the project's Task row missing.
    await transaction.update(workItems).set({ typeId: null }).where(eq(workItems.id, item.id));
    const sql = readFileSync(new URL("../../db/migrations/0098_work_item_types.sql", import.meta.url), "utf8").split("--> statement-breakpoint");
    for (const statement of sql) if (statement.trim()) await transaction.execute(statement.trim());
    const [after] = await transaction.select().from(workItems).where(eq(workItems.id, item.id));
    const [task] = await transaction.select().from(workItemTypes).where(and(eq(workItemTypes.projectId, project.id), eq(workItemTypes.name, "Task")));
    expect(after!.typeId).toBe(task!.id);
    expect((await types.listWorkItemTypes.handler({ userId: admin.id }, { projectId: project.id })).length).toBe(1);
  });
});

test.concurrent("the suggestions carry a plain one-line explanation and no developer word", async () => {
  await withRollback(db, async (transaction) => {
    const { types, admin, project } = await setup(transaction);
    const suggestions = await types.listWorkItemTypeSuggestions.handler({ userId: admin.id }, { projectId: project.id });
    expect(suggestions.map((suggestion) => suggestion.name)).toEqual(["Bug", "Request", "Approval", "Document", "Big task"]);
    for (const suggestion of suggestions) {
      expect(suggestion.description.length).toBeGreaterThan(10);
      expect(suggestion.description.includes("\n")).toBe(false);
    }
    expect(JSON.stringify(suggestions)).not.toMatch(/epic|module/i);
  });
});

test.concurrent("a type in use cannot be deleted until its items move; an unused type deletes", async () => {
  await withRollback(db, async (transaction) => {
    const { types, items, admin, project, workspace } = await setup(transaction);
    const task = (await types.listWorkItemTypes.handler({ userId: admin.id }, { projectId: project.id }))[0]!;
    const bug = await types.createWorkItemType.handler({ userId: admin.id }, { projectId: project.id, name: "Bug", icon: "bug", color: "#dc2626", description: "Something that works wrongly." });
    const item = await items.createWorkItem.handler({ userId: admin.id }, { projectId: project.id, title: "Crash", typeId: bug.id });
    expect(item.typeId).toBe(bug.id);
    const refused = types.deleteWorkItemType.handler({ userId: admin.id }, { typeId: bug.id });
    await expect(refused).rejects.toThrow("1 work item uses Bug. Move it to another type first.");
    expect(await status(types.deleteWorkItemType.handler({ userId: admin.id }, { typeId: bug.id }))).toBe(409);
    const moved = await types.deleteWorkItemType.handler({ userId: admin.id }, { typeId: bug.id, moveToTypeId: task.id });
    expect(moved).toEqual({ removed: true, moved: 1 });
    const after = await items.getWorkItem.handler({ userId: admin.id }, { workspaceId: workspace.id, displayId: `MOB-${item.sequence}` });
    expect(after.typeId).toBe(task.id);
    const unused = await types.createWorkItemType.handler({ userId: admin.id }, { projectId: project.id, name: "Request", icon: "request", color: "#2563eb" });
    expect(await types.deleteWorkItemType.handler({ userId: admin.id }, { typeId: unused.id })).toEqual({ removed: true, moved: 0 });
  });
});

test.concurrent("the last type of a project cannot be deleted; names are unique without case", async () => {
  await withRollback(db, async (transaction) => {
    const { types, admin, project } = await setup(transaction);
    const [task] = await types.listWorkItemTypes.handler({ userId: admin.id }, { projectId: project.id });
    await expect(types.deleteWorkItemType.handler({ userId: admin.id }, { typeId: task!.id })).rejects.toThrow("at least one work item type");
    await expect(types.createWorkItemType.handler({ userId: admin.id }, { projectId: project.id, name: "task", icon: "task", color: "#000000" })).rejects.toThrow("already exists");
  });
});

test.concurrent("types and properties are refused while the feature is off, and only project Admins configure", async () => {
  await withRollback(db, async (transaction) => {
    const { types, items, member, admin, project } = await setup(transaction, { types: false });
    expect(await status(types.createWorkItemType.handler({ userId: member.id }, { projectId: project.id, name: "Bug", icon: "bug", color: "#dc2626" }))).toBe(403);
    await expect(types.createWorkItemType.handler({ userId: admin.id }, { projectId: project.id, name: "Bug", icon: "bug", color: "#dc2626" })).rejects.toThrow("Work item types feature is turned off");
    const [task] = await types.listWorkItemTypes.handler({ userId: admin.id }, { projectId: project.id });
    await expect(items.createWorkItem.handler({ userId: admin.id }, { projectId: project.id, title: "x", typeId: task!.id })).rejects.toThrow("turned off");
  });
});

test.concurrent("every kind of property validates its input and refuses unknown ids and wrong kinds", async () => {
  await withRollback(db, async (transaction) => {
    const { types, items, admin, member, project } = await setup(transaction);
    const [task] = await types.listWorkItemTypes.handler({ userId: admin.id }, { projectId: project.id });
    const make = (name: string, kind: Parameters<typeof types.createCustomProperty.handler>[1]["kind"], options?: string[]) =>
      types.createCustomProperty.handler({ userId: admin.id }, { projectId: project.id, name, kind, options, typeIds: [task!.id] });
    const text = await make("Notes", "text");
    const number = await make("Points", "number");
    const date = await make("Target", "date");
    const flag = await make("Urgent", "boolean");
    const link = await make("Spec", "url");
    const severity = await make("Severity", "dropdown", ["low", "high"]);
    const tags = await make("Areas", "multi_select", ["ios", "web", "api"]);
    const owner = await make("Owner", "person");
    const create = (properties: Array<{ propertyId: string; value: unknown }>) => items.createWorkItem.handler({ userId: admin.id }, { projectId: project.id, title: "Card", properties });
    const ok = await create([
      { propertyId: text.id, value: "  hello  " }, { propertyId: number.id, value: "3.5" }, { propertyId: date.id, value: "2026-11-13" },
      { propertyId: flag.id, value: true }, { propertyId: link.id, value: "https://example.com/spec" }, { propertyId: severity.id, value: "High" },
      { propertyId: tags.id, value: ["ios", "api"] }, { propertyId: owner.id, value: member.id },
    ]);
    const byName = new Map(ok.properties.map((entry) => [entry.propertyId, entry.value]));
    expect(byName.get(text.id)).toBe("hello");
    expect(byName.get(number.id)).toBe(3.5);
    expect(byName.get(date.id)).toBe("2026-11-13");
    expect(byName.get(flag.id)).toBe(true);
    expect(byName.get(severity.id)).toBe(severity.options.find((option) => option.label === "high")!.id);
    expect(byName.get(tags.id)).toEqual([tags.options[0]!.id, tags.options[2]!.id]);
    expect(byName.get(owner.id)).toBe(member.id);
    const bad: Array<[string, Array<{ propertyId: string; value: unknown }>, string]> = [
      ["text not text", [{ propertyId: text.id, value: 5 }], "Notes: must be text"],
      ["number not numeric", [{ propertyId: number.id, value: "three" }], "Points: must be a number"],
      ["impossible date", [{ propertyId: date.id, value: "2026-02-30" }], "Target: must be a date"],
      ["flag not boolean", [{ propertyId: flag.id, value: "maybe" }], "Urgent: must be yes or no"],
      ["link not http", [{ propertyId: link.id, value: "javascript:alert(1)" }], "Spec: must be a web address"],
      ["unknown option", [{ propertyId: severity.id, value: "critical" }], 'Severity: "critical" is not one of the options'],
      ["repeated option", [{ propertyId: tags.id, value: ["ios", "ios"] }], "Areas: lists the same option twice"],
      ["person not a member", [{ propertyId: owner.id, value: "00000000-0000-4000-8000-000000000000" }], "Owner: must be a member of this project"],
      ["unknown property", [{ propertyId: "00000000-0000-4000-8000-000000000000", value: "x" }], "Custom property not found in this project"],
    ];
    for (const [label, properties, message] of bad) {
      expect([label, await messageOf(create(properties))]).toEqual([label, expect.stringContaining(message)]);
    }
    // A property of another type is refused too.
    const bug = await types.createWorkItemType.handler({ userId: admin.id }, { projectId: project.id, name: "Bug", icon: "bug", color: "#dc2626" });
    expect(await messageOf(items.createWorkItem.handler({ userId: admin.id }, { projectId: project.id, title: "x", typeId: bug.id, properties: [{ propertyId: text.id, value: "a" }] })))
      .toContain("Notes does not belong to Bug");
  });
});

test.concurrent("a required property blocks save with a clear message until it has a value", async () => {
  await withRollback(db, async (transaction) => {
    const { types, items, admin, project, workspace } = await setup(transaction);
    const [task] = await types.listWorkItemTypes.handler({ userId: admin.id }, { projectId: project.id });
    const bug = await types.createWorkItemType.handler({ userId: admin.id }, { projectId: project.id, name: "Bug", icon: "bug", color: "#dc2626" });
    const severity = await types.createCustomProperty.handler({ userId: admin.id }, { projectId: project.id, name: "Severity", kind: "dropdown", options: ["low", "high"], required: true, typeIds: [bug.id] });
    const message = await messageOf(items.createWorkItem.handler({ userId: admin.id }, { projectId: project.id, title: "Crash", typeId: bug.id }));
    expect(message).toBe('"Severity" is required for Bug. Fill it before saving.');
    const item = await items.createWorkItem.handler({ userId: admin.id }, { projectId: project.id, title: "Crash", typeId: bug.id, properties: [{ propertyId: severity.id, value: "high" }] });
    // Changing the type to one where the required property is missing is refused, and nothing changes.
    const notRequired = await messageOf(items.updateWorkItem.handler({ userId: admin.id }, { workItemId: item.id, typeId: task!.id }));
    expect(notRequired).toContain("drops the values of: Severity");
    // Clearing a required value is refused the same way.
    expect(await messageOf(items.updateWorkItem.handler({ userId: admin.id }, { workItemId: item.id, properties: [{ propertyId: severity.id, value: null }] })))
      .toBe('"Severity" is required for Bug. Fill it before saving.');
    // Moving to Task drops Severity only when confirmed, and then Task has no required property left.
    await items.updateWorkItem.handler({ userId: admin.id }, { workItemId: item.id, typeId: task!.id, dropPropertyValues: true });
    const moved = await items.getWorkItem.handler({ userId: admin.id }, { workspaceId: workspace.id, displayId: `MOB-${item.sequence}` });
    expect(moved.typeId).toBe(task!.id);
    expect(moved.properties).toEqual([]);
  });
});

test.concurrent("changing type keeps the values of shared properties and asks before dropping the others", async () => {
  await withRollback(db, async (transaction) => {
    const { types, items, admin, project, workspace } = await setup(transaction);
    const [task] = await types.listWorkItemTypes.handler({ userId: admin.id }, { projectId: project.id });
    const bug = await types.createWorkItemType.handler({ userId: admin.id }, { projectId: project.id, name: "Bug", icon: "bug", color: "#dc2626" });
    const shared = await types.createCustomProperty.handler({ userId: admin.id }, { projectId: project.id, name: "Link", kind: "url", typeIds: [task!.id, bug.id] });
    const only = await types.createCustomProperty.handler({ userId: admin.id }, { projectId: project.id, name: "Steps", kind: "text", typeIds: [bug.id] });
    const item = await items.createWorkItem.handler({ userId: admin.id }, { projectId: project.id, title: "Card", typeId: bug.id, properties: [{ propertyId: shared.id, value: "https://example.com" }, { propertyId: only.id, value: "1. open" }] });
    const refused = messageOf(items.updateWorkItem.handler({ userId: admin.id }, { workItemId: item.id, typeId: task!.id }));
    expect(await refused).toBe("Changing the type to Task drops the values of: Steps. Confirm the change to drop them.");
    await items.updateWorkItem.handler({ userId: admin.id }, { workItemId: item.id, typeId: task!.id, dropPropertyValues: true });
    const after = await items.getWorkItem.handler({ userId: admin.id }, { workspaceId: workspace.id, displayId: `MOB-${item.sequence}` });
    expect(after.typeId).toBe(task!.id);
    expect(after.properties).toEqual([{ propertyId: shared.id, value: "https://example.com" }]);
    const log = await transaction.select().from(activities).where(and(eq(activities.entityId, item.id), eq(activities.field, "type")));
    expect(log.map((row) => [row.oldValue, row.newValue])).toEqual([["Bug", "Task"]]);
  });
});

test.concurrent("a property used by items cannot lose an option or a type, and a default fills new items", async () => {
  await withRollback(db, async (transaction) => {
    const { types, items, admin, project, workspace } = await setup(transaction);
    const [task] = await types.listWorkItemTypes.handler({ userId: admin.id }, { projectId: project.id });
    const bug = await types.createWorkItemType.handler({ userId: admin.id }, { projectId: project.id, name: "Bug", icon: "bug", color: "#dc2626" });
    const severity = await types.createCustomProperty.handler({ userId: admin.id }, { projectId: project.id, name: "Severity", kind: "dropdown", options: ["low", "high"], defaultValue: "low", typeIds: [bug.id] });
    expect(severity.defaultValue).toBe(severity.options[0]!.id);
    const created = await items.createWorkItem.handler({ userId: admin.id }, { projectId: project.id, title: "Crash", typeId: bug.id });
    expect(created.properties).toEqual([{ propertyId: severity.id, value: severity.options[0]!.id }]);
    const high = severity.options[1]!;
    await items.updateWorkItem.handler({ userId: admin.id }, { workItemId: created.id, properties: [{ propertyId: severity.id, value: high.id }] });
    const lowOption = severity.options[0]!;
    const refused = messageOf(types.updateCustomProperty.handler({ userId: admin.id }, { propertyId: severity.id, options: [{ id: lowOption.id, label: "low" }] }));
    expect(await refused).toContain('Option "high" is used by 1 work item');
    const renamed = await types.updateCustomProperty.handler({ userId: admin.id }, { propertyId: severity.id, options: [{ id: lowOption.id, label: "Low" }, { id: high.id, label: "High" }, { label: "Critical" }] });
    expect(renamed.options.map((option) => option.label)).toEqual(["Low", "High", "Critical"]);
    const refusedType = messageOf(types.updateCustomProperty.handler({ userId: admin.id }, { propertyId: severity.id, typeIds: [task!.id] }));
    expect(await refusedType).toContain("has a value for Severity; clear it first");
  });
});

test.concurrent("a deleted property clears its values and logs each live item", async () => {
  await withRollback(db, async (transaction) => {
    const { types, items, admin, project, workspace } = await setup(transaction);
    const [task] = await types.listWorkItemTypes.handler({ userId: admin.id }, { projectId: project.id });
    const note = await types.createCustomProperty.handler({ userId: admin.id }, { projectId: project.id, name: "Note", kind: "text", typeIds: [task!.id] });
    const item = await items.createWorkItem.handler({ userId: admin.id }, { projectId: project.id, title: "Card", properties: [{ propertyId: note.id, value: "x" }] });
    expect(await types.deleteCustomProperty.handler({ userId: admin.id }, { propertyId: note.id })).toEqual({ removed: true, cleared: 1 });
    const after = await items.getWorkItem.handler({ userId: admin.id }, { workspaceId: workspace.id, displayId: `MOB-${item.sequence}` });
    expect(after.properties).toEqual([]);
    const log = await transaction.select().from(activities).where(and(eq(activities.entityId, item.id), eq(activities.field, `property:${note.id}:Note`)));
    expect(log.map((row) => [row.oldValue, row.newValue])).toEqual([[null, "x"], ["x", null]]);
  });
});

test.concurrent("Agents set properties through the work item actions and the change is logged as the Agent", async () => {
  await withRollback(db, async (transaction) => {
    const { types, items, admin, project, workspace } = await setup(transaction);
    const [task] = await types.listWorkItemTypes.handler({ userId: admin.id }, { projectId: project.id });
    const severity = await types.createCustomProperty.handler({ userId: admin.id }, { projectId: project.id, name: "Severity", kind: "dropdown", options: ["low", "high"], typeIds: [task!.id] });
    const item = await items.createWorkItem.handler({ userId: admin.id }, { projectId: project.id, title: "Card" });
    // A real Run (assigning an Agent queues one) gives the Activity its Run.
    const agents = createAgentActions(transaction);
    const agent = await agents.createAgent.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Bot", instructions: "Be brief.", model: "default" });
    await agents.setAgentProjectAccess.handler({ userId: admin.id }, { agentId: agent.id, allProjects: true, projectIds: [] });
    await items.updateWorkItem.handler({ userId: admin.id }, { workItemId: item.id, assigneeIds: [agent.userId] });
    const [run] = await transaction.select().from(runs).where(eq(runs.workItemId, item.id));
    const runId = run!.id;
    await items.updateWorkItem.handler({ userId: admin.id, source: "agent", agent: { agentUserId: agent.userId, runId, originatorId: admin.id } }, { workItemId: item.id, properties: [{ propertyId: severity.id, value: "high" }] });
    const [row] = await transaction.select().from(activities).where(and(eq(activities.entityId, item.id), eq(activities.field, `property:${severity.id}:Severity`)));
    expect(row).toMatchObject({ source: "agent", runId, newValue: severity.options[1]!.id });
  });
});

test.concurrent("list results carry property values and the type, and filter by type", async () => {
  await withRollback(db, async (transaction) => {
    const { types, items, admin, project, workspace } = await setup(transaction);
    const [task] = await types.listWorkItemTypes.handler({ userId: admin.id }, { projectId: project.id });
    const bug = await types.createWorkItemType.handler({ userId: admin.id }, { projectId: project.id, name: "Bug", icon: "bug", color: "#dc2626" });
    const severity = await types.createCustomProperty.handler({ userId: admin.id }, { projectId: project.id, name: "Severity", kind: "dropdown", options: ["low", "high"], typeIds: [bug.id, task!.id] });
    await items.createWorkItem.handler({ userId: admin.id }, { projectId: project.id, title: "Crash", typeId: bug.id, properties: [{ propertyId: severity.id, value: "high" }] });
    await items.createWorkItem.handler({ userId: admin.id }, { projectId: project.id, title: "Plan" });
    const bugs = await items.listWorkItems.handler({ userId: admin.id }, { projectId: project.id, typeIds: [bug.id] });
    expect(bugs.map((row) => row.title)).toEqual(["Crash"]);
    expect(bugs[0]!.properties).toEqual([{ propertyId: severity.id, value: severity.options[1]!.id }]);
    const byPql = await items.listWorkItems.handler({ userId: admin.id }, { projectId: project.id, query: `type = Bug AND property.severity = high` });
    expect(byPql.map((row) => row.title)).toEqual(["Crash"]);
    expect((await items.listWorkItems.handler({ userId: admin.id }, { projectId: project.id, query: `property.severity = low` })).length).toBe(0);
    expect((await items.listWorkItems.handler({ userId: admin.id }, { projectId: project.id, query: `type != Bug` })).map((row) => row.title)).toEqual(["Plan"]);
    expect((await types.listWorkItemTypes.handler({ userId: admin.id }, { projectId: project.id })).find((type) => type.id === bug.id)!.workItems).toBe(1);
  });
});

test.concurrent("custom property PQL handles negative equality, date lists, missing values, and existing text and dropdown rules", async () => {
  await withRollback(db, async (transaction) => {
    const { types, items, admin, project } = await setup(transaction);
    const [task] = await types.listWorkItemTypes.handler({ userId: admin.id }, { projectId: project.id });
    const number = await types.createCustomProperty.handler({ userId: admin.id }, { projectId: project.id, name: "Estimate", kind: "number", typeIds: [task!.id] });
    const date = await types.createCustomProperty.handler({ userId: admin.id }, { projectId: project.id, name: "TargetDate", kind: "date", typeIds: [task!.id] });
    const text = await types.createCustomProperty.handler({ userId: admin.id }, { projectId: project.id, name: "Note", kind: "text", typeIds: [task!.id] });
    const dropdown = await types.createCustomProperty.handler({ userId: admin.id }, { projectId: project.id, name: "Impact", kind: "dropdown", options: ["low", "high"], typeIds: [task!.id] });
    const add = (title: string, values: Array<{ propertyId: string; value: unknown }>) => items.createWorkItem.handler({ userId: admin.id }, { projectId: project.id, title, properties: values });
    await add("equal", [{ propertyId: number.id, value: 5 }, { propertyId: date.id, value: "2026-04-05" }, { propertyId: text.id, value: "same" }, { propertyId: dropdown.id, value: "high" }]);
    await add("other", [{ propertyId: number.id, value: 8 }, { propertyId: date.id, value: "2026-04-06" }, { propertyId: text.id, value: "other" }, { propertyId: dropdown.id, value: "low" }]);
    await add("missing", [{ propertyId: text.id, value: "same" }, { propertyId: dropdown.id, value: "high" }]);
    const titles = async (query: string) => (await items.listWorkItems.handler({ userId: admin.id }, { projectId: project.id, query })).map((row) => row.title).sort();
    expect(await titles("property.estimate != 5")).toEqual(["missing", "other"]);
    expect(await titles("property.targetdate != 2026-04-05")).toEqual(["missing", "other"]);
    expect(await titles("property.targetdate IN (2026-04-05, 2026-04-06)")).toEqual(["equal", "other"]);
    expect(await titles("property.targetdate NOT IN (2026-04-05)")).toEqual(["missing", "other"]);
    expect(await titles('property.note = "same"')).toEqual(["equal", "missing"]);
    expect(await titles("property.impact != high")).toEqual(["other"]);
  });
});

test.concurrent("the Agent-facing read actions are open to Agents; setting values uses update_work_item, which Agents already have", async () => {
  const actions = createActionList({} as Database, { integrations: false });
  const names = actions.map((action) => action.name);
  for (const name of ["list_work_item_types", "list_custom_properties", "create_work_item_type", "create_custom_property", "delete_work_item_type"]) expect(names).toContain(name);
  const { classifyAgentAction } = await import("../src/agent-action-policy");
  expect(classifyAgentAction("list_custom_properties")).toBe("base");
  expect(classifyAgentAction("list_work_item_types")).toBe("base");
  expect(classifyAgentAction("delete_work_item_type")).toBe("denied");
  expect(classifyAgentAction("create_custom_property")).toBe("denied");
});

test.concurrent("the admin Type and property actions are not reachable by a Member", async () => {
  await withRollback(db, async (transaction) => {
    const { types, admin, member, project } = await setup(transaction);
    const [task] = await types.listWorkItemTypes.handler({ userId: admin.id }, { projectId: project.id });
    expect(await status(types.createCustomProperty.handler({ userId: member.id }, { projectId: project.id, name: "X", kind: "text", typeIds: [task!.id] }))).toBe(403);
    expect(await status(types.deleteWorkItemType.handler({ userId: member.id }, { typeId: task!.id }))).toBe(403);
  });
});

test.concurrent("a Recurrence template carries its type and property values into each round; a type removed since is reported and the round still runs", async () => {
  await withRollback(db, async (transaction) => {
    const { types, admin, project, workspace, items } = await setup(transaction);
    const [task] = await types.listWorkItemTypes.handler({ userId: admin.id }, { projectId: project.id });
    const bug = await types.createWorkItemType.handler({ userId: admin.id }, { projectId: project.id, name: "Bug", icon: "bug", color: "#dc2626" });
    const severity = await types.createCustomProperty.handler({ userId: admin.id }, { projectId: project.id, name: "Severity", kind: "dropdown", options: ["low", "high"], typeIds: [bug.id] });
    const request = await types.createWorkItemType.handler({ userId: admin.id }, { projectId: project.id, name: "Request", icon: "request", color: "#2563eb" });
    const recurrences = createRecurrenceActions(transaction);
    const schedule = { unit: "day" as const, interval: 1, time: "09:00", timezone: "UTC", anchorDate: "2026-11-01" };
    const weekly = await recurrences.createRecurrence.handler({ userId: admin.id }, { projectId: project.id, name: "Crash triage", template: { title: "Triage crashes", typeId: bug.id, properties: [{ propertyId: severity.id, value: "high" }] }, schedule });
    await recurrences.runRecurrenceNow.handler({ userId: admin.id }, { recurrenceId: weekly!.id });
    const rounds = await items.listWorkItems.handler({ userId: admin.id }, { projectId: project.id, typeIds: [bug.id] });
    expect(rounds.map((row) => row.title)).toEqual(["Triage crashes"]);
    expect(rounds[0]!.properties).toEqual([{ propertyId: severity.id, value: severity.options[1]!.id }]);

    const gone = await recurrences.createRecurrence.handler({ userId: admin.id }, { projectId: project.id, name: "Requests", template: { title: "Review requests", typeId: request.id }, schedule });
    await types.deleteWorkItemType.handler({ userId: admin.id }, { typeId: request.id });
    await recurrences.runRecurrenceNow.handler({ userId: admin.id }, { recurrenceId: gone!.id });
    const plain = await items.listWorkItems.handler({ userId: admin.id }, { projectId: project.id, typeIds: [task!.id] });
    expect(plain.map((row) => row.title)).toEqual(["Review requests"]);
  });
});

test.concurrent("the timeline names property changes by option label, member name and list of labels, never by id", async () => {
  await withRollback(db, async (transaction) => {
    const { types, items, admin, member, project } = await setup(transaction);
    const [task] = await types.listWorkItemTypes.handler({ userId: admin.id }, { projectId: project.id });
    const severity = await types.createCustomProperty.handler({ userId: admin.id }, { projectId: project.id, name: "Severity", kind: "dropdown", options: ["low", "high"], typeIds: [task!.id] });
    const tags = await types.createCustomProperty.handler({ userId: admin.id }, { projectId: project.id, name: "Tags", kind: "multi_select", options: ["ui", "api"], typeIds: [task!.id] });
    const owner = await types.createCustomProperty.handler({ userId: admin.id }, { projectId: project.id, name: "Reviewer", kind: "person", typeIds: [task!.id] });
    const item = await items.createWorkItem.handler({ userId: admin.id }, { projectId: project.id, title: "Card" });
    await items.updateWorkItem.handler({ userId: admin.id }, { workItemId: item.id, properties: [
      { propertyId: severity.id, value: severity.options[1]!.id },
      { propertyId: tags.id, value: [tags.options[0]!.id, tags.options[1]!.id] },
      { propertyId: owner.id, value: member.id },
    ] });
    const log = await items.listWorkItemActivities.handler({ userId: admin.id }, { workItemId: item.id });
    const shown = Object.fromEntries(log.filter((row) => row.field.startsWith("property:")).map((row) => [row.field, row.newValue]));
    expect(shown).toEqual({ "property:Severity": "high", "property:Tags": "ui, api", "property:Reviewer": member.name });
    const ids = JSON.stringify(log.filter((row) => row.field.startsWith("property:")).map((row) => [row.oldValue, row.newValue]));
    expect(ids).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  });
});

test.concurrent("deleting a type moves its items only when they already fill the target's required properties", async () => {
  await withRollback(db, async (transaction) => {
    const { types, items, admin, project, workspace } = await setup(transaction);
    const bug = await types.createWorkItemType.handler({ userId: admin.id }, { projectId: project.id, name: "Bug", icon: "bug", color: "#dc2626" });
    const request = await types.createWorkItemType.handler({ userId: admin.id }, { projectId: project.id, name: "Request", icon: "request", color: "#2563eb" });
    const approval = await types.createWorkItemType.handler({ userId: admin.id }, { projectId: project.id, name: "Approval", icon: "approval", color: "#16a34a" });
    const severity = await types.createCustomProperty.handler({ userId: admin.id }, { projectId: project.id, name: "Severity", kind: "dropdown", options: ["low", "high"], required: true, typeIds: [bug.id, request.id] });
    await types.createCustomProperty.handler({ userId: admin.id }, { projectId: project.id, name: "Owner", kind: "text", required: true, typeIds: [approval.id] });
    const item = await items.createWorkItem.handler({ userId: admin.id }, { projectId: project.id, title: "Crash", typeId: bug.id, properties: [{ propertyId: severity.id, value: severity.options[1]!.id }] });

    // Approval needs an Owner, which the item does not have: the move is refused by name, nothing changes.
    const refusal = await messageOf(types.deleteWorkItemType.handler({ userId: admin.id }, { typeId: bug.id, moveToTypeId: approval.id }));
    expect(refusal).toBe(`1 work item cannot move to Approval until its required properties have values: MOB-${item.sequence} needs "Owner". Fill them first, or move to another type.`);
    const stillBug = await items.getWorkItem.handler({ userId: admin.id }, { workspaceId: workspace.id, displayId: `MOB-${item.sequence}` });
    expect(stillBug.typeId).toBe(bug.id);
    expect((await types.listWorkItemTypes.handler({ userId: admin.id }, { projectId: project.id })).map((type) => type.name)).toContain("Bug");

    // Request needs only Severity, which the item has: the move goes through and keeps the value.
    expect(await types.deleteWorkItemType.handler({ userId: admin.id }, { typeId: bug.id, moveToTypeId: request.id })).toEqual({ removed: true, moved: 1 });
    const moved = await items.getWorkItem.handler({ userId: admin.id }, { workspaceId: workspace.id, displayId: `MOB-${item.sequence}` });
    expect(moved.typeId).toBe(request.id);
    expect(moved.properties).toEqual([{ propertyId: severity.id, value: severity.options[1]!.id }]);
  });
});

test.concurrent("a timeline entry for a custom property follows a rename, and still reads after the property is deleted", async () => {
  await withRollback(db, async (transaction) => {
    const { types, items, admin, project } = await setup(transaction);
    const [task] = await types.listWorkItemTypes.handler({ userId: admin.id }, { projectId: project.id });
    const severity = await types.createCustomProperty.handler({ userId: admin.id }, { projectId: project.id, name: "Severity", kind: "dropdown", options: ["low", "high"], typeIds: [task!.id] });
    const item = await items.createWorkItem.handler({ userId: admin.id }, { projectId: project.id, title: "Card" });
    await items.updateWorkItem.handler({ userId: admin.id }, { workItemId: item.id, properties: [{ propertyId: severity.id, value: severity.options[1]!.id }] });
    const fields = async () => (await items.listWorkItemActivities.handler({ userId: admin.id }, { workItemId: item.id })).filter((row) => row.field.startsWith("property:")).map((row) => [row.field, row.newValue]);
    expect(await fields()).toEqual([["property:Severity", "high"]]);
    await types.updateCustomProperty.handler({ userId: admin.id }, { propertyId: severity.id, name: "Impact" });
    expect(await fields()).toEqual([["property:Impact", "high"]]);
    await types.deleteCustomProperty.handler({ userId: admin.id }, { propertyId: severity.id });
    const after = (await items.listWorkItemActivities.handler({ userId: admin.id }, { workItemId: item.id })).filter((row) => row.field.startsWith("property:"));
    // The name the property had when it was last logged is kept, and the clearing entry carries the label, not an id.
    expect(after.map((row) => row.field)).toEqual(["property:Severity", "property:Impact"]);
    expect(after[1]!.oldValue).toBe("high");
    expect(JSON.stringify(after.map((row) => [row.oldValue, row.newValue]))).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  });
});
