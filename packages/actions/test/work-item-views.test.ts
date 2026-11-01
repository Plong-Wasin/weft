import { afterAll, expect, test } from "bun:test";
import { asc, eq } from "drizzle-orm";
import { activities, createDatabase, workItems, type Database } from "@weft/db";
import { createProjectActions, createWorkItemActions } from "../src";
import { createMemberFactory, createWorkspaceFactory, withRollback } from "../../db/src/test-helpers";

const { client, db } = createDatabase();
afterAll(async () => client.end());

async function setup(transaction: Database) {
  const workspace = await createWorkspaceFactory(transaction);
  const member = await createMemberFactory(transaction, workspace.id, "Member");
  const guest = await createMemberFactory(transaction, workspace.id, "Guest");
  const projects = createProjectActions(transaction);
  const items = createWorkItemActions(transaction);
  const project = await projects.createProject.handler({ userId: member.id }, { workspaceId: workspace.id, name: "Mobile", key: "MOB", visibility: "public" });
  const states = await items.listStates.handler({ userId: member.id }, { projectId: project.id });
  const create = (title: string, extra: Record<string, unknown> = {}) => items.createWorkItem.handler({ userId: member.id }, { projectId: project.id, title, ...extra });
  const list = (input: Record<string, unknown> = {}) => items.listWorkItems.handler({ userId: member.id }, { projectId: project.id, ...input });
  return { workspace, member, guest, projects, items, project, states, create, list };
}

test.concurrent("moving between two cards writes one fractional sort order and renumbers nothing", async () => {
  await withRollback(db, async (transaction) => {
    const { items, member, create, list } = await setup(transaction);
    const [a, b, c] = [await create("A"), await create("B"), await create("C")];
    const before = new Map((await list()).map((item) => [item.id, item.sortOrder]));
    const moved = await items.moveWorkItem.handler({ userId: member.id }, { workItemId: c.id, stateId: c.stateId, beforeId: b.id });
    expect(moved.sortOrder).toBeGreaterThan(before.get(a.id)!);
    expect(moved.sortOrder).toBeLessThan(before.get(b.id)!);
    const after = await list();
    expect(after.map((item) => item.title)).toEqual(["A", "C", "B"]);
    expect(after.find((item) => item.id === a.id)!.sortOrder).toBe(before.get(a.id)!);
    expect(after.find((item) => item.id === b.id)!.sortOrder).toBe(before.get(b.id)!);
  });
});

test.concurrent("repeated moves into the same gap keep order without touching neighbours", async () => {
  await withRollback(db, async (transaction) => {
    const { items, member, create, list } = await setup(transaction);
    const first = await create("first");
    const last = await create("last");
    const stored = new Map((await list()).map((item) => [item.id, item.sortOrder]));
    let upper = last.id;
    for (let index = 0; index < 20; index += 1) {
      const card = await create(`n${index}`);
      await items.moveWorkItem.handler({ userId: member.id }, { workItemId: card.id, stateId: card.stateId, beforeId: upper });
      upper = card.id;
    }
    const after = await list();
    expect(after[0]!.id).toBe(first.id);
    expect(after.at(-1)!.id).toBe(last.id);
    expect(after.find((item) => item.id === first.id)!.sortOrder).toBe(stored.get(first.id)!);
    expect(after.find((item) => item.id === last.id)!.sortOrder).toBe(stored.get(last.id)!);
    expect(new Set(after.map((item) => item.sortOrder)).size).toBe(after.length);
  });
});

test.concurrent("dragging to another state changes the state, places the card, and writes an Activity", async () => {
  await withRollback(db, async (transaction) => {
    const { items, member, states, create } = await setup(transaction);
    const todo = states.find((state) => state.group === "unstarted")!;
    const card = await create("Card");
    const top = await create("Top", { stateId: todo.id });
    const moved = await items.moveWorkItem.handler({ userId: member.id, source: "ui" }, { workItemId: card.id, stateId: todo.id, beforeId: top.id });
    expect(moved.stateId).toBe(todo.id);
    const column = (await items.listWorkItems.handler({ userId: member.id }, { projectId: card.projectId, stateIds: [todo.id] })).map((item) => item.title);
    expect(column).toEqual(["Card", "Top"]);
    const rows = await transaction.select().from(activities).where(eq(activities.entityId, card.id)).orderBy(asc(activities.seq));
    const change = rows.find((row) => row.field === "state")!;
    expect(change).toMatchObject({ oldValue: card.stateId, newValue: todo.id, actorId: member.id, source: "ui" });
  });
});

test.concurrent("dropping at the end of a column and into an empty column", async () => {
  await withRollback(db, async (transaction) => {
    const { items, member, states, create, list } = await setup(transaction);
    const done = states.find((state) => state.group === "completed")!;
    const a = await create("A");
    const b = await create("B");
    await items.moveWorkItem.handler({ userId: member.id }, { workItemId: a.id, stateId: a.stateId });
    expect((await list()).map((item) => item.title)).toEqual(["B", "A"]);
    const moved = await items.moveWorkItem.handler({ userId: member.id }, { workItemId: b.id, stateId: done.id });
    expect(moved.stateId).toBe(done.id);
    expect((await list({ stateIds: [done.id] })).map((item) => item.title)).toEqual(["B"]);
  });
});

test.concurrent("a pure reorder inside a column writes no state Activity", async () => {
  await withRollback(db, async (transaction) => {
    const { items, member, create } = await setup(transaction);
    const a = await create("A");
    const b = await create("B");
    await items.moveWorkItem.handler({ userId: member.id }, { workItemId: b.id, stateId: b.stateId, beforeId: a.id });
    const rows = await transaction.select().from(activities).where(eq(activities.entityId, b.id));
    expect(rows.map((row) => row.field)).toEqual(["created"]);
  });
});

test.concurrent("a collapsed gap rebalances the column instead of losing order", async () => {
  await withRollback(db, async (transaction) => {
    const { items, member, create, list } = await setup(transaction);
    const a = await create("A");
    const b = await create("B");
    const c = await create("C");
    await transaction.update(workItems).set({ sortOrder: 1 }).where(eq(workItems.id, a.id));
    await transaction.update(workItems).set({ sortOrder: 1 + Number.EPSILON * 2 }).where(eq(workItems.id, b.id));
    await items.moveWorkItem.handler({ userId: member.id }, { workItemId: c.id, stateId: c.stateId, beforeId: b.id });
    expect((await list()).map((item) => item.title)).toEqual(["A", "C", "B"]);
  });
});

test.concurrent("move rejects guests, foreign states, and neighbours from another column", async () => {
  await withRollback(db, async (transaction) => {
    const { items, guest, member, projects, workspace, states, create } = await setup(transaction);
    const other = await projects.createProject.handler({ userId: member.id }, { workspaceId: workspace.id, name: "Other", key: "OTH", visibility: "public" });
    const otherStates = await items.listStates.handler({ userId: member.id }, { projectId: other.id });
    const card = await create("Card");
    const done = states.find((state) => state.group === "completed")!;
    const inDone = await create("In done", { stateId: done.id });
    await expect(items.moveWorkItem.handler({ userId: guest.id }, { workItemId: card.id, stateId: done.id })).rejects.toMatchObject({ status: 403 });
    await expect(items.moveWorkItem.handler({ userId: member.id }, { workItemId: card.id, stateId: otherStates[0]!.id })).rejects.toMatchObject({ status: 400 });
    await expect(items.moveWorkItem.handler({ userId: member.id }, { workItemId: card.id, stateId: card.stateId, beforeId: inDone.id })).rejects.toMatchObject({ status: 400 });
    await expect(items.moveWorkItem.handler({ userId: member.id }, { workItemId: card.id, stateId: card.stateId, beforeId: card.id })).rejects.toMatchObject({ status: 400 });
  });
});

test.concurrent("list filters by state, priority, assignee and label, and combines them", async () => {
  await withRollback(db, async (transaction) => {
    const { items, member, projects, project, workspace, states, create, list } = await setup(transaction);
    const second = await createMemberFactory(transaction, workspace.id, "Member");
    await projects.addProjectMember.handler({ userId: member.id }, { projectId: project.id, userId: second.id, role: "Member" });
    const bug = await items.createLabel.handler({ userId: member.id }, { projectId: project.id, name: "bug" });
    const done = states.find((state) => state.group === "completed")!;
    const a = await create("A", { priority: "urgent", assigneeIds: [member.id], labelIds: [bug.id] });
    const b = await create("B", { priority: "low", assigneeIds: [second.id], stateId: done.id });
    const c = await create("C", { priority: "urgent" });
    const titles = async (input: Record<string, unknown>) => (await list(input)).map((item) => item.title).sort();
    expect(await titles({ stateIds: [done.id] })).toEqual(["B"]);
    expect(await titles({ priorities: ["urgent"] })).toEqual(["A", "C"]);
    expect(await titles({ assigneeIds: [second.id] })).toEqual(["B"]);
    expect(await titles({ labelIds: [bug.id] })).toEqual(["A"]);
    expect(await titles({ priorities: ["urgent"], assigneeIds: [member.id, second.id] })).toEqual(["A"]);
    expect(await titles({ assigneeIds: ["none"] })).toEqual(["C"]);
    expect(await titles({ priorities: ["urgent", "low"] })).toEqual(["A", "B", "C"]);
    expect([a.id, b.id, c.id]).toHaveLength(3);
  });
});

test.concurrent("list sorts by priority, title, and created, ascending or descending", async () => {
  await withRollback(db, async (transaction) => {
    const { create, list } = await setup(transaction);
    await create("b", { priority: "low" });
    await create("c", { priority: "urgent" });
    await create("a", { priority: "none" });
    const titles = async (input: Record<string, unknown>) => (await list(input)).map((item) => item.title);
    expect(await titles({ sort: "priority" })).toEqual(["c", "b", "a"]);
    expect(await titles({ sort: "priority", direction: "desc" })).toEqual(["a", "b", "c"]);
    expect(await titles({ sort: "title" })).toEqual(["a", "b", "c"]);
    expect(await titles({ sort: "title", direction: "desc" })).toEqual(["c", "b", "a"]);
    expect(await titles({ sort: "created", direction: "desc" })).toEqual(["a", "c", "b"]);
    expect(await titles({})).toEqual(["b", "c", "a"]);
  });
});
