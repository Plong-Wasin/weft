import { afterAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { activities, createDatabase, workItems, type Database } from "@weft/db";
import { createCycleActions, createProjectActions, createWorkItemActions, cycleStatus, todayIso } from "../src";
import { createMemberFactory, createWorkspaceFactory, withRollback } from "../../db/src/test-helpers";

const { client, db } = createDatabase();
afterAll(async () => client.end());

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

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
  const item = (title = "Item") => work.createWorkItem.handler({ userId: member.id }, { projectId: project.id, title });
  return { workspace, admin, member, guest, outsider, projects, project, work, item, cycles: createCycleActions(transaction) };
}

test("cycleStatus is computed from today and both end points are inclusive", () => {
  expect(cycleStatus("2026-03-01", "2026-03-14", "2026-02-28")).toBe("upcoming");
  expect(cycleStatus("2026-03-01", "2026-03-14", "2026-03-01")).toBe("active");
  expect(cycleStatus("2026-03-01", "2026-03-14", "2026-03-14")).toBe("active");
  expect(cycleStatus("2026-03-01", "2026-03-14", "2026-03-15")).toBe("completed");
  expect(todayIso(new Date("2026-05-06T23:59:59Z"))).toBe("2026-05-06");
});

test.concurrent("a Member creates, updates, lists and gets a Cycle with computed status", async () => {
  await withRollback(db, async (transaction) => {
    const { cycles, member, guest, project } = await setup(transaction);
    const created = await cycles.createCycle.handler({ userId: member.id }, { projectId: project.id, name: "Sprint 1", startDate: day(-1), endDate: day(6) });
    expect(created).toMatchObject({ name: "Sprint 1", status: "active", itemCount: 0, projectId: project.id });
    const later = await cycles.createCycle.handler({ userId: member.id }, { projectId: project.id, name: "Sprint 2", startDate: day(7), endDate: day(13) });
    const past = await cycles.createCycle.handler({ userId: member.id }, { projectId: project.id, name: "Sprint 0", startDate: day(-20), endDate: day(-10) });
    expect(later.status).toBe("upcoming");
    expect(past.status).toBe("completed");
    const renamed = await cycles.updateCycle.handler({ userId: member.id }, { cycleId: created.id, name: "Sprint 1b", endDate: day(10) });
    expect(renamed).toMatchObject({ name: "Sprint 1b", endDate: day(10) });
    expect((await cycles.listCycles.handler({ userId: guest.id }, { projectId: project.id })).map((row) => row.name)).toEqual(["Sprint 0", "Sprint 1b", "Sprint 2"]);
    expect(await cycles.getCycle.handler({ userId: guest.id }, { cycleId: created.id })).toMatchObject({ id: created.id, workItemIds: [] });
  });
});

test.concurrent("invalid dates are refused", async () => {
  await withRollback(db, async (transaction) => {
    const { cycles, member, project } = await setup(transaction);
    for (const [startDate, endDate] of [[day(5), day(1)], ["2026-02-30", "2026-03-01"]] as const) {
      await expect(cycles.createCycle.handler({ userId: member.id }, { projectId: project.id, name: "Bad", startDate, endDate })).rejects.toMatchObject({ status: 400 });
    }
    const cycle = await cycles.createCycle.handler({ userId: member.id }, { projectId: project.id, name: "Ok", startDate: day(1), endDate: day(5) });
    await expect(cycles.updateCycle.handler({ userId: member.id }, { cycleId: cycle.id, startDate: day(9) })).rejects.toMatchObject({ status: 400 });
  });
});

test.concurrent("check_cycle_dates returns overlapping Cycles (inclusive) and never blocks creation", async () => {
  await withRollback(db, async (transaction) => {
    const { cycles, member, guest, project } = await setup(transaction);
    const first = await cycles.createCycle.handler({ userId: member.id }, { projectId: project.id, name: "A", startDate: day(0), endDate: day(6) });
    const check = (startDate: string, endDate: string, cycleId?: string) => cycles.checkCycleDates.handler({ userId: guest.id }, { projectId: project.id, startDate, endDate, ...(cycleId ? { cycleId } : {}) });
    expect((await check(day(3), day(9))).overlapping.map((row) => row.id)).toEqual([first.id]);
    expect((await check(day(6), day(9))).overlapping.map((row) => row.id)).toEqual([first.id]);
    expect((await check(day(7), day(9))).overlapping).toEqual([]);
    expect((await check(day(3), day(9), first.id)).overlapping).toEqual([]);
    const overlapping = await cycles.createCycle.handler({ userId: member.id }, { projectId: project.id, name: "B", startDate: day(3), endDate: day(9) });
    expect(overlapping.name).toBe("B");
  });
});

test.concurrent("adding items: at most one Cycle, skipped items are reported, Activity records ids and source", async () => {
  await withRollback(db, async (transaction) => {
    const { cycles, member, project, item } = await setup(transaction);
    const [a, b, c] = [await item("a"), await item("b"), await item("c")];
    const one = await cycles.createCycle.handler({ userId: member.id }, { projectId: project.id, name: "One", startDate: day(0), endDate: day(6) });
    const two = await cycles.createCycle.handler({ userId: member.id }, { projectId: project.id, name: "Two", startDate: day(7), endDate: day(13) });
    expect(await cycles.addCycleItems.handler({ userId: member.id, source: "cli" }, { cycleId: one.id, workItemIds: [a.id, b.id] })).toEqual({ added: [a.id, b.id], skipped: [] });
    const result = await cycles.addCycleItems.handler({ userId: member.id }, { cycleId: two.id, workItemIds: [b.id, c.id] });
    expect(result).toEqual({ added: [c.id], skipped: [{ workItemId: b.id, cycleId: one.id }] });
    // Adding what is already there is a no-op, not a skip.
    expect(await cycles.addCycleItems.handler({ userId: member.id }, { cycleId: one.id, workItemIds: [a.id] })).toEqual({ added: [], skipped: [] });
    expect((await cycles.getCycle.handler({ userId: member.id }, { cycleId: one.id })).workItemIds.sort()).toEqual([a.id, b.id].sort());
    expect((await cycles.listCycles.handler({ userId: member.id }, { projectId: project.id })).map((row) => row.itemCount)).toEqual([2, 1]);
    const rows = await transaction.select().from(activities).where(and(eq(activities.entityId, a.id), eq(activities.field, "cycle")));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ oldValue: null, newValue: one.id, source: "cli", entityType: "work_item", actorId: member.id });
    expect(await transaction.select().from(activities).where(and(eq(activities.entityId, b.id), eq(activities.field, "cycle")))).toHaveLength(1);
  });
});

test.concurrent("removing items frees them for another Cycle and writes Activity", async () => {
  await withRollback(db, async (transaction) => {
    const { cycles, member, project, item } = await setup(transaction);
    const a = await item();
    const one = await cycles.createCycle.handler({ userId: member.id }, { projectId: project.id, name: "One", startDate: day(0), endDate: day(6) });
    const two = await cycles.createCycle.handler({ userId: member.id }, { projectId: project.id, name: "Two", startDate: day(0), endDate: day(6) });
    await cycles.addCycleItems.handler({ userId: member.id }, { cycleId: one.id, workItemIds: [a.id] });
    expect(await cycles.removeCycleItems.handler({ userId: member.id, source: "ai", chatId: crypto.randomUUID() }, { cycleId: one.id, workItemIds: [a.id] })).toEqual({ removed: [a.id] });
    expect(await cycles.removeCycleItems.handler({ userId: member.id }, { cycleId: one.id, workItemIds: [a.id] })).toEqual({ removed: [] });
    expect((await cycles.addCycleItems.handler({ userId: member.id }, { cycleId: two.id, workItemIds: [a.id] })).added).toEqual([a.id]);
    const rows = await transaction.select().from(activities).where(and(eq(activities.entityId, a.id), eq(activities.field, "cycle")));
    expect(rows.map((row) => [row.oldValue, row.newValue, row.source])).toEqual([[null, one.id, "ui"], [one.id, null, "ai"], [null, two.id, "ui"]]);
  });
});

test.concurrent("a Cycle whose end date has passed refuses new work items with 400", async () => {
  await withRollback(db, async (transaction) => {
    const { cycles, member, project, item } = await setup(transaction);
    const a = await item();
    const ended = await cycles.createCycle.handler({ userId: member.id }, { projectId: project.id, name: "Old", startDate: day(-14), endDate: day(-1) });
    await expect(cycles.addCycleItems.handler({ userId: member.id }, { cycleId: ended.id, workItemIds: [a.id] })).rejects.toMatchObject({ status: 400 });
    const endsToday = await cycles.createCycle.handler({ userId: member.id }, { projectId: project.id, name: "Today", startDate: day(-14), endDate: day(0) });
    expect((await cycles.addCycleItems.handler({ userId: member.id }, { cycleId: endsToday.id, workItemIds: [a.id] })).added).toEqual([a.id]);
  });
});

test.concurrent("work items must belong to the Cycle's project and not be deleted", async () => {
  await withRollback(db, async (transaction) => {
    const { cycles, member, admin, project, work, projects, workspace, item } = await setup(transaction);
    const other = await projects.createProject.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Other", key: "OTH", visibility: "public" });
    const foreign = await work.createWorkItem.handler({ userId: admin.id }, { projectId: other.id, title: "foreign" });
    const gone = await item();
    await work.deleteWorkItem.handler({ userId: member.id }, { workItemId: gone.id });
    const cycle = await cycles.createCycle.handler({ userId: member.id }, { projectId: project.id, name: "One", startDate: day(0), endDate: day(6) });
    for (const id of [foreign.id, gone.id, crypto.randomUUID()]) {
      await expect(cycles.addCycleItems.handler({ userId: member.id }, { cycleId: cycle.id, workItemIds: [id] })).rejects.toMatchObject({ status: 400 });
    }
  });
});

test.concurrent("list_work_items filters by Cycle", async () => {
  await withRollback(db, async (transaction) => {
    const { cycles, member, admin, project, work, item, projects, workspace } = await setup(transaction);
    const [a] = [await item("a"), await item("b")];
    const cycle = await cycles.createCycle.handler({ userId: member.id }, { projectId: project.id, name: "One", startDate: day(0), endDate: day(6) });
    await cycles.addCycleItems.handler({ userId: member.id }, { cycleId: cycle.id, workItemIds: [a.id] });
    expect((await work.listWorkItems.handler({ userId: member.id }, { projectId: project.id, cycleId: cycle.id })).map((row) => row.id)).toEqual([a.id]);
    expect(await work.listWorkItems.handler({ userId: member.id }, { projectId: project.id })).toHaveLength(2);
    const other = await projects.createProject.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Other", key: "OTH", visibility: "public" });
    await expect(work.listWorkItems.handler({ userId: admin.id }, { projectId: other.id, cycleId: cycle.id })).rejects.toMatchObject({ status: 404 });
    await cycles.deleteCycle.handler({ userId: admin.id }, { cycleId: cycle.id });
    await expect(work.listWorkItems.handler({ userId: member.id }, { projectId: project.id, cycleId: cycle.id })).rejects.toMatchObject({ status: 404 });
  });
});

test.concurrent("Guests read but never write; outsiders of a private project see nothing", async () => {
  await withRollback(db, async (transaction) => {
    const { cycles, member, guest, outsider, project, item } = await setup(transaction, "private");
    const a = await item();
    const cycle = await cycles.createCycle.handler({ userId: member.id }, { projectId: project.id, name: "One", startDate: day(0), endDate: day(6) });
    const writes = [
      () => cycles.createCycle.handler({ userId: guest.id }, { projectId: project.id, name: "x", startDate: day(0), endDate: day(1) }),
      () => cycles.updateCycle.handler({ userId: guest.id }, { cycleId: cycle.id, name: "x" }),
      () => cycles.addCycleItems.handler({ userId: guest.id }, { cycleId: cycle.id, workItemIds: [a.id] }),
      () => cycles.removeCycleItems.handler({ userId: guest.id }, { cycleId: cycle.id, workItemIds: [a.id] }),
    ];
    for (const write of writes) await expect(write()).rejects.toMatchObject({ status: 403 });
    const reads = [
      () => cycles.listCycles.handler({ userId: outsider.id }, { projectId: project.id }),
      () => cycles.getCycle.handler({ userId: outsider.id }, { cycleId: cycle.id }),
      () => cycles.checkCycleDates.handler({ userId: outsider.id }, { projectId: project.id, startDate: day(0), endDate: day(1) }),
      () => cycles.createCycle.handler({ userId: outsider.id }, { projectId: project.id, name: "x", startDate: day(0), endDate: day(1) }),
      () => cycles.addCycleItems.handler({ userId: outsider.id }, { cycleId: cycle.id, workItemIds: [a.id] }),
    ];
    for (const read of reads) await expect(read()).rejects.toMatchObject({ status: 404 });
    expect(await cycles.listCycles.handler({ userId: guest.id }, { projectId: project.id })).toHaveLength(1);
  });
});

test.concurrent("feature toggles: default on, Admin only, off rejects every Cycle Action and keeps the data", async () => {
  await withRollback(db, async (transaction) => {
    const { cycles, projects, member, admin, project, work, item, workspace } = await setup(transaction);
    expect(project.features).toEqual({ cycles: true, modules: true, intake: true });
    const a = await item();
    const cycle = await cycles.createCycle.handler({ userId: member.id }, { projectId: project.id, name: "One", startDate: day(0), endDate: day(6) });
    await cycles.addCycleItems.handler({ userId: member.id }, { cycleId: cycle.id, workItemIds: [a.id] });
    await expect(projects.setProjectFeatures.handler({ userId: member.id }, { projectId: project.id, features: { cycles: false } })).rejects.toMatchObject({ status: 403 });
    const off = await projects.setProjectFeatures.handler({ userId: admin.id }, { projectId: project.id, features: { cycles: false } });
    expect(off.features).toEqual({ cycles: false, modules: true, intake: true });
    const calls = [
      () => cycles.createCycle.handler({ userId: member.id }, { projectId: project.id, name: "x", startDate: day(0), endDate: day(1) }),
      () => cycles.updateCycle.handler({ userId: member.id }, { cycleId: cycle.id, name: "x" }),
      () => cycles.listCycles.handler({ userId: member.id }, { projectId: project.id }),
      () => cycles.getCycle.handler({ userId: member.id }, { cycleId: cycle.id }),
      () => cycles.checkCycleDates.handler({ userId: member.id }, { projectId: project.id, startDate: day(0), endDate: day(1) }),
      () => cycles.addCycleItems.handler({ userId: member.id }, { cycleId: cycle.id, workItemIds: [a.id] }),
      () => cycles.removeCycleItems.handler({ userId: member.id }, { cycleId: cycle.id, workItemIds: [a.id] }),
      () => work.listWorkItems.handler({ userId: member.id }, { projectId: project.id, cycleId: cycle.id }),
    ];
    for (const call of calls) await expect(call()).rejects.toMatchObject({ status: 400 });
    // An empty patch changes nothing; other features are untouched; turning it back on shows the kept data.
    expect((await projects.setProjectFeatures.handler({ userId: admin.id }, { projectId: project.id, features: {} })).features.cycles).toBe(false);
    expect((await projects.getProject.handler({ userId: member.id }, { workspaceId: workspace.id, key: "MOB" })).features.cycles).toBe(false);
    await projects.setProjectFeatures.handler({ userId: admin.id }, { projectId: project.id, features: { cycles: true, modules: false } });
    expect((await cycles.getCycle.handler({ userId: member.id }, { cycleId: cycle.id })).workItemIds).toEqual([a.id]);
  });
});

/** A Cycle holding one item per default state, then moved into the past (items cannot be added to an ended Cycle). */
async function endedCycle(transaction: Database) {
  const ctx = await setup(transaction);
  const states = await ctx.work.listStates.handler({ userId: ctx.member.id }, { projectId: ctx.project.id });
  const byName = (name: string) => states.find((state) => state.name === name)!.id;
  const cycle = await ctx.cycles.createCycle.handler({ userId: ctx.member.id }, { projectId: ctx.project.id, name: "Sprint 1", startDate: day(-3), endDate: day(3) });
  const made: Record<string, string> = {};
  for (const name of ["Todo", "In Progress", "Done", "Cancelled"]) {
    const created = await ctx.item(name);
    await ctx.work.updateWorkItem.handler({ userId: ctx.member.id }, { workItemId: created.id, stateId: byName(name) } as never);
    made[name] = created.id;
  }
  await ctx.cycles.addCycleItems.handler({ userId: ctx.member.id }, { cycleId: cycle.id, workItemIds: Object.values(made) });
  const ended = await ctx.cycles.updateCycle.handler({ userId: ctx.member.id }, { cycleId: cycle.id, startDate: day(-20), endDate: day(-10) });
  const next = await ctx.cycles.createCycle.handler({ userId: ctx.member.id }, { projectId: ctx.project.id, name: "Sprint 2", startDate: day(1), endDate: day(14) });
  return { ...ctx, cycle: ended, next, made };
}

test.concurrent("progress is completed over work items that are not cancelled", async () => {
  await withRollback(db, async (transaction) => {
    const { cycles, member, cycle } = await endedCycle(transaction);
    expect(cycle.progress).toEqual({ completed: 1, total: 3 });
    expect(cycle.itemCount).toBe(4);
    expect((await cycles.getCycle.handler({ userId: member.id }, { cycleId: cycle.id })).progress).toEqual({ completed: 1, total: 3 });
    expect((await cycles.listCycles.handler({ userId: member.id }, { projectId: cycle.projectId })).find((row) => row.id === cycle.id)!.progress).toEqual({ completed: 1, total: 3 });
  });
});

test.concurrent("transfer moves only unfinished items, writes Activity, and nothing moves on its own", async () => {
  await withRollback(db, async (transaction) => {
    const { cycles, member, cycle, next, made } = await endedCycle(transaction);
    // Nothing automatic: the ended Cycle keeps all four items until someone transfers.
    expect((await cycles.getCycle.handler({ userId: member.id }, { cycleId: cycle.id })).workItemIds).toHaveLength(4);
    const result = await cycles.transferCycleItems.handler({ userId: member.id, source: "ui" }, { cycleId: cycle.id, targetCycleId: next.id });
    expect(result.transferred.sort()).toEqual([made["Todo"]!, made["In Progress"]!].sort());
    expect((await cycles.getCycle.handler({ userId: member.id }, { cycleId: cycle.id })).workItemIds.sort()).toEqual([made["Done"]!, made["Cancelled"]!].sort());
    expect((await cycles.getCycle.handler({ userId: member.id }, { cycleId: next.id })).workItemIds.sort()).toEqual(result.transferred.sort());
    const rows = await transaction.select().from(activities).where(and(eq(activities.field, "cycle"), eq(activities.entityId, made["Todo"]!)));
    expect(rows.find((row) => row.oldValue === cycle.id)).toMatchObject({ newValue: next.id, actorId: member.id, source: "ui" });
  });
});

test.concurrent("transfer is refused from a running Cycle, to an ended or other-project Cycle, and to a Guest", async () => {
  await withRollback(db, async (transaction) => {
    const { cycles, member, guest, admin, cycle, next, projects, workspace } = await endedCycle(transaction);
    await expect(cycles.transferCycleItems.handler({ userId: guest.id }, { cycleId: cycle.id, targetCycleId: next.id })).rejects.toMatchObject({ status: 403 });
    await expect(cycles.transferCycleItems.handler({ userId: member.id }, { cycleId: next.id, targetCycleId: cycle.id })).rejects.toMatchObject({ status: 400 });
    await expect(cycles.transferCycleItems.handler({ userId: member.id }, { cycleId: cycle.id, targetCycleId: cycle.id })).rejects.toMatchObject({ status: 400 });
    const old = await cycles.createCycle.handler({ userId: member.id }, { projectId: cycle.projectId, name: "Old", startDate: day(-9), endDate: day(-8) });
    await expect(cycles.transferCycleItems.handler({ userId: member.id }, { cycleId: cycle.id, targetCycleId: old.id })).rejects.toMatchObject({ status: 400 });
    const other = await projects.createProject.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Other", key: "OTH", visibility: "public" });
    const foreign = await cycles.createCycle.handler({ userId: admin.id }, { projectId: other.id, name: "Foreign", startDate: day(1), endDate: day(2) });
    await expect(cycles.transferCycleItems.handler({ userId: member.id }, { cycleId: cycle.id, targetCycleId: foreign.id })).rejects.toMatchObject({ status: 404 });
  });
});

test.concurrent("archive is Admin only and only for a completed Cycle; archived Cycles leave the default list but keep items", async () => {
  await withRollback(db, async (transaction) => {
    const { cycles, member, admin, cycle, next, project } = await endedCycle(transaction);
    await expect(cycles.archiveCycle.handler({ userId: member.id }, { cycleId: cycle.id })).rejects.toMatchObject({ status: 403 });
    await expect(cycles.archiveCycle.handler({ userId: admin.id }, { cycleId: next.id })).rejects.toMatchObject({ status: 400 });
    expect(await cycles.archiveCycle.handler({ userId: admin.id }, { cycleId: cycle.id })).toMatchObject({ archived: true, itemCount: 4 });
    expect((await cycles.listCycles.handler({ userId: member.id }, { projectId: project.id })).map((row) => row.name)).toEqual(["Sprint 2"]);
    expect((await cycles.listCycles.handler({ userId: member.id }, { projectId: project.id, archived: true })).map((row) => row.name)).toEqual(["Sprint 1"]);
    expect((await cycles.getCycle.handler({ userId: member.id }, { cycleId: cycle.id })).workItemIds).toHaveLength(4);
    await expect(cycles.transferCycleItems.handler({ userId: member.id }, { cycleId: next.id, targetCycleId: cycle.id })).rejects.toMatchObject({ status: 400 });
  });
});

test.concurrent("delete is soft, Admin only, removes membership and keeps the work items", async () => {
  await withRollback(db, async (transaction) => {
    const { cycles, member, admin, cycle, project, made } = await endedCycle(transaction);
    await expect(cycles.deleteCycle.handler({ userId: member.id }, { cycleId: cycle.id })).rejects.toMatchObject({ status: 403 });
    const result = await cycles.deleteCycle.handler({ userId: admin.id }, { cycleId: cycle.id });
    expect(result.released).toHaveLength(4);
    expect((await cycles.listCycles.handler({ userId: member.id }, { projectId: project.id })).map((row) => row.name)).toEqual(["Sprint 2"]);
    expect((await cycles.listCycles.handler({ userId: member.id }, { projectId: project.id, archived: true }))).toEqual([]);
    await expect(cycles.getCycle.handler({ userId: member.id }, { cycleId: cycle.id })).rejects.toMatchObject({ status: 404 });
    await expect(cycles.deleteCycle.handler({ userId: admin.id }, { cycleId: cycle.id })).rejects.toMatchObject({ status: 404 });
    const kept = await transaction.select().from(workItems).where(eq(workItems.id, made["Todo"]!));
    expect(kept[0]).toMatchObject({ deletedAt: null });
    const rows = await transaction.select().from(activities).where(and(eq(activities.field, "cycle"), eq(activities.entityId, made["Todo"]!)));
    expect(rows.some((row) => row.oldValue === cycle.id && row.newValue === null)).toBe(true);
  });
});
