import { afterAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { activities, createDatabase, workItems, type Database } from "@weft/db";
import { createCycleActions, createIntakeActions, createModuleActions, createProjectActions, createWorkItemActions } from "../src";
import { createMemberFactory, createWorkspaceFactory, withRollback } from "../../db/src/test-helpers";

const { client, db } = createDatabase();
afterAll(async () => client.end());

async function setup(transaction: Database, visibility: "public" | "private" = "public") {
  const workspace = await createWorkspaceFactory(transaction);
  const admin = await createMemberFactory(transaction, workspace.id, "Admin");
  const member = await createMemberFactory(transaction, workspace.id, "Member");
  const guest = await createMemberFactory(transaction, workspace.id, "Guest");
  const outsider = await createMemberFactory(transaction, workspace.id, "Member");
  const projects = createProjectActions(transaction);
  const project = await projects.createProject.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Mobile", key: "MOB", visibility });
  await projects.addProjectMember.handler({ userId: admin.id }, { projectId: project.id, userId: member.id, role: "Member" });
  await projects.addProjectMember.handler({ userId: admin.id }, { projectId: project.id, userId: guest.id, role: "Guest" });
  const work = createWorkItemActions(transaction);
  const item = (title = "Item", userId = member.id) => work.createWorkItem.handler({ userId }, { projectId: project.id, title });
  return { workspace, admin, member, guest, outsider, projects, project, work, item, modules: createModuleActions(transaction) };
}

test.concurrent("a Member creates, updates, lists and gets a Module; status is set by hand", async () => {
  await withRollback(db, async (transaction) => {
    const { modules, member, guest, admin, project } = await setup(transaction);
    const created = await modules.createModule.handler({ userId: member.id }, { projectId: project.id, name: "Auth", leadId: member.id, memberIds: [admin.id], startDate: "2030-01-01", endDate: "2030-02-01" });
    expect(created).toMatchObject({ name: "Auth", status: "backlog", leadId: member.id, memberIds: [admin.id], startDate: "2030-01-01", archived: false, itemCount: 0 });
    const updated = await modules.updateModule.handler({ userId: member.id }, { moduleId: created.id, status: "in-progress", endDate: null, memberIds: [] });
    expect(updated).toMatchObject({ status: "in-progress", endDate: null, memberIds: [], startDate: "2030-01-01" });
    for (const status of ["planned", "paused", "completed", "cancelled", "backlog"] as const) expect((await modules.updateModule.handler({ userId: member.id }, { moduleId: created.id, status })).status).toBe(status);
    expect((await modules.listModules.handler({ userId: guest.id }, { projectId: project.id })).map((row) => row.name)).toEqual(["Auth"]);
    expect(await modules.getModule.handler({ userId: guest.id }, { moduleId: created.id })).toMatchObject({ id: created.id, workItemIds: [] });
  });
});

test.concurrent("validation: dates, status, lead outside the project", async () => {
  await withRollback(db, async (transaction) => {
    const { modules, member, outsider, project } = await setup(transaction);
    const bad = (input: Record<string, unknown>) => modules.createModule.handler({ userId: member.id }, { projectId: project.id, name: "X", ...input } as never).then(() => 200, (error: { status: number }) => error.status);
    expect(await bad({ startDate: "2030-02-02", endDate: "2030-02-01" })).toBe(400);
    expect(await bad({ startDate: "2030-02-30" })).toBe(400);
    expect(await bad({ leadId: outsider.id })).toBe(400);
    expect(await bad({ memberIds: [outsider.id] })).toBe(400);
  });
});

test.concurrent("a work item is in many Modules and one Cycle at once; Activity records module ids and source", async () => {
  await withRollback(db, async (transaction) => {
    const { modules, member, project, item } = await setup(transaction);
    const a = await modules.createModule.handler({ userId: member.id }, { projectId: project.id, name: "A" });
    const b = await modules.createModule.handler({ userId: member.id }, { projectId: project.id, name: "B" });
    const cycles = createCycleActions(transaction);
    const cycle = await cycles.createCycle.handler({ userId: member.id }, { projectId: project.id, name: "Sprint", startDate: "2030-01-01", endDate: "2030-01-14" });
    const one = await item();
    expect(await modules.addModuleItems.handler({ userId: member.id, source: "mcp" }, { moduleId: a.id, workItemIds: [one.id] })).toEqual({ added: [one.id] });
    expect(await modules.addModuleItems.handler({ userId: member.id }, { moduleId: b.id, workItemIds: [one.id] })).toEqual({ added: [one.id] });
    // Adding again is a no-op and writes no second Activity row.
    expect(await modules.addModuleItems.handler({ userId: member.id }, { moduleId: a.id, workItemIds: [one.id] })).toEqual({ added: [] });
    expect((await cycles.addCycleItems.handler({ userId: member.id }, { cycleId: cycle.id, workItemIds: [one.id] })).added).toEqual([one.id]);
    const rows = await transaction.select().from(activities).where(and(eq(activities.entityId, one.id), eq(activities.field, "module")));
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.newValue === a.id)).toMatchObject({ source: "mcp", oldValue: null, actorId: member.id });
    expect(await modules.removeModuleItems.handler({ userId: member.id }, { moduleId: a.id, workItemIds: [one.id] })).toEqual({ removed: [one.id] });
    expect((await modules.getModule.handler({ userId: member.id }, { moduleId: b.id })).workItemIds).toEqual([one.id]);
    expect(await transaction.select().from(activities).where(and(eq(activities.entityId, one.id), eq(activities.field, "module"), eq(activities.oldValue as never, a.id)))).toHaveLength(1);
  });
});

test.concurrent("work items must belong to the Module's project", async () => {
  await withRollback(db, async (transaction) => {
    const { modules, member, admin, projects, workspace, project, item } = await setup(transaction);
    const other = await projects.createProject.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Other", key: "OTH", visibility: "public" });
    const foreign = await createWorkItemActions(transaction).createWorkItem.handler({ userId: admin.id }, { projectId: other.id, title: "Foreign" });
    const mod = await modules.createModule.handler({ userId: member.id }, { projectId: project.id, name: "A" });
    await item();
    const status = await modules.addModuleItems.handler({ userId: member.id }, { moduleId: mod.id, workItemIds: [foreign.id] }).then(() => 200, (error: { status: number }) => error.status);
    expect(status).toBe(400);
  });
});

test.concurrent("progress counts completed against non-cancelled work items", async () => {
  await withRollback(db, async (transaction) => {
    const { modules, member, work, project, item } = await setup(transaction);
    const mod = await modules.createModule.handler({ userId: member.id }, { projectId: project.id, name: "A" });
    const [a, b, c, d] = [await item(), await item(), await item(), await item()];
    await modules.addModuleItems.handler({ userId: member.id }, { moduleId: mod.id, workItemIds: [a.id, b.id, c.id, d.id] });
    const states = await work.listStates.handler({ userId: member.id }, { projectId: project.id });
    const done = states.find((state) => state.group === "completed")!, cancelled = states.find((state) => state.group === "cancelled")!;
    await transaction.update(workItems).set({ stateId: done.id }).where(eq(workItems.id, a.id));
    await transaction.update(workItems).set({ stateId: cancelled.id }).where(eq(workItems.id, b.id));
    expect((await modules.getModule.handler({ userId: member.id }, { moduleId: mod.id })).progress).toEqual({ total: 4, completed: 1, cancelled: 1, percent: 33 });
    expect((await modules.listModules.handler({ userId: member.id }, { projectId: project.id }))[0]!.progress.percent).toBe(33);
  });
});

test.concurrent("list_work_items filters by moduleId", async () => {
  await withRollback(db, async (transaction) => {
    const { modules, member, work, project, item } = await setup(transaction);
    const mod = await modules.createModule.handler({ userId: member.id }, { projectId: project.id, name: "A" });
    const [a] = [await item("In"), await item("Out")];
    await modules.addModuleItems.handler({ userId: member.id }, { moduleId: mod.id, workItemIds: [a.id] });
    expect((await work.listWorkItems.handler({ userId: member.id }, { projectId: project.id, moduleId: mod.id })).map((row) => row.title)).toEqual(["In"]);
    const missing = await work.listWorkItems.handler({ userId: member.id }, { projectId: project.id, moduleId: crypto.randomUUID() }).then(() => 200, (error: { status: number }) => error.status);
    expect(missing).toBe(404);
  });
});

test.concurrent("archive is Admin only and needs completed or cancelled; archived is hidden from the default list", async () => {
  await withRollback(db, async (transaction) => {
    const { modules, member, admin, project, item } = await setup(transaction);
    const mod = await modules.createModule.handler({ userId: member.id }, { projectId: project.id, name: "A" });
    const status = (user: string, name: "archiveModule" | "unarchiveModule" | "deleteModule") => modules[name].handler({ userId: user }, { moduleId: mod.id }).then(() => 200, (error: { status: number }) => error.status);
    expect(await status(member.id, "archiveModule")).toBe(403);
    expect(await status(admin.id, "archiveModule")).toBe(400);
    await modules.updateModule.handler({ userId: member.id }, { moduleId: mod.id, status: "completed" });
    expect(await status(member.id, "archiveModule")).toBe(403);
    expect((await modules.archiveModule.handler({ userId: admin.id }, { moduleId: mod.id })).archived).toBe(true);
    expect(await modules.listModules.handler({ userId: member.id }, { projectId: project.id })).toEqual([]);
    expect((await modules.listModules.handler({ userId: member.id }, { projectId: project.id, archived: true })).map((row) => row.id)).toEqual([mod.id]);
    // An archived Module is read-only.
    const one = await item();
    expect(await modules.addModuleItems.handler({ userId: member.id }, { moduleId: mod.id, workItemIds: [one.id] }).then(() => 200, (error: { status: number }) => error.status)).toBe(400);
    expect(await modules.updateModule.handler({ userId: member.id }, { moduleId: mod.id, name: "B" }).then(() => 200, (error: { status: number }) => error.status)).toBe(400);
    expect(await status(member.id, "unarchiveModule")).toBe(403);
    expect((await modules.unarchiveModule.handler({ userId: admin.id }, { moduleId: mod.id })).archived).toBe(false);
    await modules.updateModule.handler({ userId: member.id }, { moduleId: mod.id, status: "cancelled" });
    expect((await modules.archiveModule.handler({ userId: admin.id }, { moduleId: mod.id })).archived).toBe(true);
  });
});

test.concurrent("delete is Admin only, soft, and removes membership but never work items", async () => {
  await withRollback(db, async (transaction) => {
    const { modules, member, admin, work, workspace, project, item } = await setup(transaction);
    const mod = await modules.createModule.handler({ userId: member.id }, { projectId: project.id, name: "A" });
    const one = await item();
    await modules.addModuleItems.handler({ userId: member.id }, { moduleId: mod.id, workItemIds: [one.id] });
    expect(await modules.deleteModule.handler({ userId: member.id }, { moduleId: mod.id }).then(() => 200, (error: { status: number }) => error.status)).toBe(403);
    expect(await modules.deleteModule.handler({ userId: admin.id }, { moduleId: mod.id })).toEqual({ deleted: true });
    expect(await modules.getModule.handler({ userId: admin.id }, { moduleId: mod.id }).then(() => 200, (error: { status: number }) => error.status)).toBe(404);
    expect(await modules.listModules.handler({ userId: admin.id }, { projectId: project.id })).toEqual([]);
    expect(await modules.listModules.handler({ userId: admin.id }, { projectId: project.id, archived: true })).toEqual([]);
    expect((await work.getWorkItem.handler({ userId: member.id }, { workspaceId: workspace.id, displayId: one.displayId } as never)).id).toBe(one.id);
    const rows = await transaction.select().from(activities).where(and(eq(activities.entityId, one.id), eq(activities.field, "module")));
    expect(rows.map((row) => [row.oldValue, row.newValue])).toEqual([[null, mod.id], [mod.id, null]]);
  });
});

test.concurrent("Guest reads but never writes; a non-member of a private project reaches nothing", async () => {
  await withRollback(db, async (transaction) => {
    const { modules, member, guest, outsider, project } = await setup(transaction, "private");
    const mod = await modules.createModule.handler({ userId: member.id }, { projectId: project.id, name: "A" });
    const code = (promise: Promise<unknown>) => promise.then(() => 200, (error: { status: number }) => error.status);
    expect(await code(modules.createModule.handler({ userId: guest.id }, { projectId: project.id, name: "G" }))).toBe(403);
    expect(await code(modules.updateModule.handler({ userId: guest.id }, { moduleId: mod.id, name: "G" }))).toBe(403);
    expect(await code(modules.getModule.handler({ userId: guest.id }, { moduleId: mod.id }))).toBe(200);
    expect(await code(modules.getModule.handler({ userId: outsider.id }, { moduleId: mod.id }))).toBe(404);
    expect(await code(modules.listModules.handler({ userId: outsider.id }, { projectId: project.id }))).toBe(404);
  });
});

test.concurrent("a project with Modules turned off rejects every Module Action and keeps the data", async () => {
  await withRollback(db, async (transaction) => {
    const { modules, member, admin, projects, project, work } = await setup(transaction);
    const mod = await modules.createModule.handler({ userId: member.id }, { projectId: project.id, name: "A" });
    await projects.setProjectFeatures.handler({ userId: admin.id }, { projectId: project.id, features: { modules: false } });
    const code = (promise: Promise<unknown>) => promise.then(() => 200, (error: { status: number }) => error.status);
    expect(await code(modules.listModules.handler({ userId: member.id }, { projectId: project.id }))).toBe(400);
    expect(await code(modules.getModule.handler({ userId: member.id }, { moduleId: mod.id }))).toBe(400);
    expect(await code(modules.createModule.handler({ userId: member.id }, { projectId: project.id, name: "B" }))).toBe(400);
    expect(await code(work.listWorkItems.handler({ userId: member.id }, { projectId: project.id, moduleId: mod.id }))).toBe(400);
    await projects.setProjectFeatures.handler({ userId: admin.id }, { projectId: project.id, features: { modules: true } });
    expect((await modules.listModules.handler({ userId: member.id }, { projectId: project.id })).map((row) => row.id)).toEqual([mod.id]);
  });
});

test.concurrent("a work item still in Intake cannot join a Module and never counts in one", async () => {
  await withRollback(db, async (transaction) => {
    const { admin, member, project, work, item, modules } = await setup(transaction);
    const module = await modules.createModule.handler({ userId: member.id }, { projectId: project.id, name: "Auth" });
    const pending = await createIntakeActions(transaction).submitIntakeItem.handler({ userId: member.id }, { projectId: project.id, title: "Waiting" });
    await expect(modules.addModuleItems.handler({ userId: member.id }, { moduleId: module.id, workItemIds: [pending.workItemId] })).rejects.toMatchObject({ status: 400 });
    const live = await item();
    await modules.addModuleItems.handler({ userId: member.id }, { moduleId: module.id, workItemIds: [live.id] });
    const listed = await work.listWorkItems.handler({ userId: admin.id }, { projectId: project.id, moduleId: module.id });
    expect(listed.map((row) => row.id)).toEqual([live.id]);
    expect((await modules.getModule.handler({ userId: admin.id }, { moduleId: module.id })).progress.total).toBe(1);
  });
});
