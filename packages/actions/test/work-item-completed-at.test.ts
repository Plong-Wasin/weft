import { afterAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { activities, createDatabase, workItemStates, workItems, type Database } from "@weft/db";
import { createIntakeActions, createProjectActions, createWorkItemActions } from "../src";
import { createMemberFactory, createWorkspaceFactory, withRollback } from "../../db/src/test-helpers";

const { client, db } = createDatabase();
afterAll(async () => client.end());

const longAgo = new Date("2020-01-01T00:00:00Z");

async function setup(transaction: Database) {
  const workspace = await createWorkspaceFactory(transaction);
  const admin = await createMemberFactory(transaction, workspace.id, "Admin");
  const guest = await createMemberFactory(transaction, workspace.id, "Guest");
  const projects = createProjectActions(transaction);
  const project = await projects.createProject.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Mobile", key: "MOB", visibility: "public" });
  const work = createWorkItemActions(transaction);
  const states = await work.listStates.handler({ userId: admin.id }, { projectId: project.id });
  const stateOf = (group: string) => states.find((state) => state.group === group)!.id;
  const as = { userId: admin.id };
  const create = (group: string) => work.createWorkItem.handler(as, { projectId: project.id, title: "Item", stateId: stateOf(group) });
  const move = (workItemId: string, group: string) => work.moveWorkItem.handler(as, { workItemId, stateId: stateOf(group) });
  const stored = async (id: string) => (await transaction.select({ completedAt: workItems.completedAt }).from(workItems).where(eq(workItems.id, id)))[0]!.completedAt;
  return { workspace, admin, guest, project, work, as, stateOf, create, move, stored, transaction };
}

test.concurrent("entering a completed state sets the time, from create, move and update", async () => {
  await withRollback(db, async (transaction) => {
    const { work, as, create, move, stateOf } = await setup(transaction);
    const created = await create("completed");
    expect(created.completedAt).not.toBeNull();
    expect((await create("started")).completedAt).toBeNull();
    const open = await create("unstarted");
    expect((await move(open.id, "completed")).completedAt).not.toBeNull();
    const other = await create("unstarted");
    const updated = await work.updateWorkItem.handler(as, { workItemId: other.id, stateId: stateOf("completed") });
    expect(updated.completedAt).not.toBeNull();
  });
});

test.concurrent("leaving the completed group clears the time, and completing again sets a fresh one", async () => {
  await withRollback(db, async (transaction) => {
    const { create, move, stored, transaction: tx } = await setup(transaction);
    const item = await create("completed");
    await tx.update(workItems).set({ completedAt: longAgo }).where(eq(workItems.id, item.id));
    expect((await move(item.id, "started")).completedAt).toBeNull();
    expect(await stored(item.id)).toBeNull();
    expect((await move(item.id, "completed")).completedAt).not.toBe(longAgo.toISOString());
    expect(await stored(item.id)).not.toBeNull();
    expect((await move(item.id, "backlog")).completedAt).toBeNull();
  });
});

test.concurrent("moving between two completed states keeps the original time", async () => {
  await withRollback(db, async (transaction) => {
    const { create, stored, transaction: tx, project, workspace } = await setup(transaction);
    const item = await create("completed");
    const [second] = await tx.insert(workItemStates).values({ workspaceId: workspace.id, projectId: project.id, name: "Shipped", group: "completed", sortOrder: 99 }).returning();
    await tx.update(workItems).set({ completedAt: longAgo }).where(eq(workItems.id, item.id));
    await tx.update(workItems).set({ stateId: second!.id }).where(eq(workItems.id, item.id));
    expect((await stored(item.id))?.toISOString()).toBe(longAgo.toISOString());
  });
});

test.concurrent("cancelled does not set the time and clears an earlier one", async () => {
  await withRollback(db, async (transaction) => {
    const { create, move, stored } = await setup(transaction);
    expect((await create("cancelled")).completedAt).toBeNull();
    const item = await create("completed");
    expect((await move(item.id, "cancelled")).completedAt).toBeNull();
    expect(await stored(item.id)).toBeNull();
    const open = await create("unstarted");
    expect((await move(open.id, "cancelled")).completedAt).toBeNull();
  });
});

test.concurrent("Intake accept moves into Backlog and leaves the time empty", async () => {
  await withRollback(db, async (transaction) => {
    const { guest, admin, project } = await setup(transaction);
    await createProjectActions(transaction).addProjectMember.handler({ userId: admin.id }, { projectId: project.id, userId: guest.id, role: "Guest" });
    const intake = createIntakeActions(transaction);
    const submitted = await intake.submitIntakeItem.handler({ userId: guest.id }, { projectId: project.id, title: "Please add dark mode" });
    await intake.acceptIntakeItem.handler({ userId: admin.id }, { intakeItemId: submitted.id });
    const [row] = await transaction.select().from(workItems).where(eq(workItems.projectId, project.id));
    expect(row!.completedAt).toBeNull();
  });
});

test.concurrent("the migration backfill uses the Activity entry, falls back to the update time, and runs twice safely", async () => {
  await withRollback(db, async (transaction) => {
    const { create, stored, transaction: tx, project, workspace, admin, stateOf } = await setup(transaction);
    const withEntry = await create("completed"), withoutEntry = await create("completed"), openItem = await create("started");
    const moved = new Date("2021-03-04T05:06:07Z"), updated = new Date("2022-01-02T03:04:05Z");
    await tx.update(workItems).set({ completedAt: null, updatedAt: updated }).where(eq(workItems.id, withEntry.id));
    await tx.update(workItems).set({ completedAt: null, updatedAt: updated }).where(eq(workItems.id, withoutEntry.id));
    const old = { workspaceId: workspace.id, projectId: project.id, entityType: "work_item", field: "state", actorId: admin.id, source: "ui" };
    await tx.insert(activities).values([
      { ...old, entityId: withEntry.id, oldValue: stateOf("started"), newValue: stateOf("completed"), createdAt: new Date("2020-06-01T00:00:00Z") },
      { ...old, entityId: withEntry.id, oldValue: stateOf("completed"), newValue: stateOf("started"), createdAt: new Date("2020-07-01T00:00:00Z") },
      { ...old, entityId: withEntry.id, oldValue: stateOf("started"), newValue: stateOf("completed"), createdAt: moved },
    ]);
    const statements = readFileSync(new URL("../../db/migrations/0061_work_item_completed_at.sql", import.meta.url), "utf8").split("--> statement-breakpoint")
      .filter((part) => part.includes("UPDATE work_items"));
    for (let run = 0; run < 2; run += 1) for (const statement of statements) await tx.execute(sql.raw(statement));
    expect((await stored(withEntry.id))?.toISOString()).toBe(moved.toISOString());
    expect((await stored(withoutEntry.id))?.toISOString()).toBe(updated.toISOString());
    expect(await stored(openItem.id)).toBeNull();
  });
});
