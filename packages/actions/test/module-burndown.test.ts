import { afterAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createDatabase, modules as moduleTable, moduleHistory, workItems, workItemStates, type Database } from "@weft/db";
import { createActionList, createEstimateActions, createModuleActions, createProjectActions, createWorkItemActions } from "../src";
import { createMemberFactory, createWorkspaceFactory, withRollback } from "../../db/src/test-helpers";

const { client, db } = createDatabase();
afterAll(async () => client.end());

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const at = (date: string, time = "12:00:00") => new Date(`${date}T${time}Z`);

async function setup(transaction: Database, startDate: string | null, endDate: string | null) {
  const workspace = await createWorkspaceFactory(transaction);
  const admin = await createMemberFactory(transaction, workspace.id, "Admin");
  const outsider = await createMemberFactory(transaction, workspace.id, "Member");
  const project = await createProjectActions(transaction).createProject.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Mobile", key: "MOB", visibility: "private" });
  const work = createWorkItemActions(transaction);
  const modules = createModuleActions(transaction);
  const as = { userId: admin.id };
  const module = await modules.createModule.handler(as, { projectId: project.id, name: "Topic", startDate, endDate });
  const item = async (completedAt: Date | null = null, estimatePointId?: string) => {
    const created = await work.createWorkItem.handler(as, { projectId: project.id, title: "Item", ...(estimatePointId ? { estimatePointId } : {}) });
    await transaction.update(workItems).set({ completedAt, createdAt: at("2020-01-01") }).where(eq(workItems.id, created.id));
    return created;
  };
  return { workspace, project, outsider, modules, work, module, as, item, add: (ids: string[]) => modules.addModuleItems.handler(as, { moduleId: module.id, workItemIds: ids }) };
}

test.concurrent("history records additions, removals, estimate changes, completion, reopen and cancellation", async () => {
  await withRollback(db, async (transaction) => {
    const { modules, module, as, project, work, item, add } = await setup(transaction, null, null);
    const estimates = createEstimateActions(transaction);
    const estimate = await estimates.createEstimate.handler(as, { projectId: project.id, type: "points", values: ["1", "2", "3", "5"] });
    const [one, two, three, five] = estimate.points;
    const a = await item(null, one!.id), b = await item(null, two!.id), c = await item(null, three!.id), d = await item(null, five!.id), unestimated = await item();
    await add([a.id, b.id, c.id, d.id, unestimated.id]);
    const completed = (await transaction.select({ id: workItemStates.id }).from(workItemStates).where(eq(workItemStates.group, "completed")).limit(1))[0]!;
    const open = (await transaction.select({ id: workItemStates.id }).from(workItemStates).where(eq(workItemStates.group, "started")).limit(1))[0]!;
    const cancelled = (await transaction.select({ id: workItemStates.id }).from(workItemStates).where(eq(workItemStates.group, "cancelled")).limit(1))[0]!;
    await work.updateWorkItem.handler(as, { workItemId: a.id, estimatePointId: two!.id });
    await work.updateWorkItem.handler(as, { workItemId: a.id, stateId: completed.id });
    await work.updateWorkItem.handler(as, { workItemId: b.id, stateId: completed.id });
    await work.updateWorkItem.handler(as, { workItemId: b.id, stateId: open.id });
    await work.updateWorkItem.handler(as, { workItemId: c.id, stateId: cancelled.id });
    await estimates.updateEstimate.handler(as, { projectId: project.id, points: estimate.points.map((point) => ({ id: point.id, value: point.id === two!.id ? "4" : point.value })) });
    await modules.removeModuleItems.handler(as, { moduleId: module.id, workItemIds: [d.id] });
    expect(await modules.getModuleBurndown.handler(as, { moduleId: module.id })).toMatchObject({ reason: "missing_start_date", days: [] });
    await modules.updateModule.handler(as, { moduleId: module.id, startDate: day(-5), endDate: day(1) });

    // The fixture shifts real Action-generated history across days so the report can exercise a complete timeline.
    await transaction.update(moduleTable).set({ historyStartedAt: at(day(-7)) }).where(eq(moduleTable.id, module.id));
    const events = await transaction.select().from(moduleHistory).where(eq(moduleHistory.moduleId, module.id));
    for (const event of events) {
      let date = day(-6);
      if (event.estimate === "4") date = day(-1);
      else if (event.workItemId === a.id && event.kind === "snapshot") date = event.stateGroup === "completed" ? day(-3) : day(-4);
      else if (event.workItemId === b.id && event.kind === "snapshot") date = event.stateGroup === "completed" ? day(-2) : day(-1);
      if (event.workItemId === c.id && event.kind === "snapshot") date = day(-1);
      if (event.workItemId === d.id && event.kind === "membership" && event.member === false) date = day(-1);
      await transaction.update(moduleHistory).set({ occurredAt: at(date, "12:00:00") }).where(eq(moduleHistory.id, event.id));
    }

    const result = await modules.getModuleBurndown.handler(as, { moduleId: module.id });
    expect(result).toMatchObject({ moduleId: module.id, startDate: day(-5), endDate: day(1), total: 5, reason: null, coverageStart: expect.any(String) });
    expect(result.days.map((row) => [row.open, row.completed, row.cancelled, row.pointsOpen, row.pointsCompleted, row.pointsCancelled, row.unestimatedOpen, row.unknown])).toEqual([
      [5, 0, 0, 11, 0, 0, 1, false], [5, 0, 0, 12, 0, 0, 1, false], [4, 1, 0, 10, 2, 0, 1, false],
      [3, 2, 0, 8, 4, 0, 1, false], [2, 1, 1, 4, 4, 3, 1, false], [null, null, null, null, null, null, null, true], [null, null, null, null, null, null, null, true],
    ]);
    expect(result.days[0]?.ideal).toBe(5);
    const points = await modules.getModuleBurndown.handler(as, { moduleId: module.id, unit: "points" });
    expect(points.unestimated).toBe(1);
    expect(points.days.map((row) => row.idealPoints)).toEqual([11, 9.17, 7.33, 5.5, 3.67, 1.83, 0]);
  });
});

test.concurrent("missing start date, target date or work items gives a reason and no days", async () => {
  await withRollback(db, async (transaction) => {
    const noStart = await setup(transaction, null, day(1));
    await noStart.add([(await noStart.item()).id]);
    expect(await noStart.modules.getModuleBurndown.handler(noStart.as, { moduleId: noStart.module.id })).toMatchObject({ reason: "missing_start_date", days: [] });
    const noEnd = await setup(transaction, day(-1), null);
    await noEnd.add([(await noEnd.item()).id]);
    expect(await noEnd.modules.getModuleBurndown.handler(noEnd.as, { moduleId: noEnd.module.id })).toMatchObject({ reason: "missing_target_date", days: [] });
    const empty = await setup(transaction, day(-1), day(1));
    expect(await empty.modules.getModuleBurndown.handler(empty.as, { moduleId: empty.module.id })).toMatchObject({ reason: "no_work_items", days: [], total: 0 });
  });
});

test.concurrent("Module history is recorded without dates and later reports unknown historical coverage", async () => {
  await withRollback(db, async (transaction) => {
    const { modules, module, as, item, add, work } = await setup(transaction, null, null);
    const a = await item();
    await add([a.id]);
    const completed = await transaction.select({ id: workItemStates.id }).from(workItemStates).where(eq(workItemStates.group, "completed")).limit(1);
    await work.updateWorkItem.handler(as, { workItemId: a.id, stateId: completed[0]!.id });
    await transaction.update(moduleTable).set({ startDate: day(-3), endDate: day(1) }).where(eq(moduleTable.id, module.id));

    const events = await transaction.select().from(moduleHistory).where(eq(moduleHistory.moduleId, module.id));
    expect(events.some((event) => event.kind === "membership" && event.member === true)).toBe(true);
    expect(events.some((event) => event.kind === "snapshot" && event.stateGroup === "completed")).toBe(true);
    const report = await modules.getModuleBurndown.handler(as, { moduleId: module.id });
    expect(report).toMatchObject({ startDate: day(-3), endDate: day(1), reason: null, coverageStart: expect.any(String) });
    expect(report.days[0]).toMatchObject({ date: day(-3), open: null, unknown: true });
    expect(report.days[1]).toMatchObject({ date: day(-2), open: null, unknown: true });
    // Module status stays a manual field; a date range does not write a Cycle-style close outcome.
    expect((await modules.getModule.handler(as, { moduleId: module.id })).status).toBe("backlog");
    expect("finalOutcome" in report).toBe(false);
  });
});

test.concurrent("Module start-day coverage after UTC midnight leaves the initial scope and ideal line unknown", async () => {
  await withRollback(db, async (transaction) => {
    const { modules, module, as, item, add } = await setup(transaction, day(-4), day(-2));
    const workItem = await item();
    await add([workItem.id]);
    await transaction.update(moduleTable).set({ historyStartedAt: at(day(-4), "12:00:00") }).where(eq(moduleTable.id, module.id));
    const events = await transaction.select().from(moduleHistory).where(eq(moduleHistory.moduleId, module.id));
    for (const event of events) await transaction.update(moduleHistory).set({ occurredAt: at(day(-4), "13:00:00") }).where(eq(moduleHistory.id, event.id));

    const report = await modules.getModuleBurndown.handler(as, { moduleId: module.id });
    expect(report.days[0]).toMatchObject({ unknown: false, open: 1, ideal: null });
    expect(report.days[1]).toMatchObject({ unknown: false, open: 1 });
  });
});

test.concurrent("deleting a workspace cascades Module history without retaining an orphan", async () => {
  await withRollback(db, async (transaction) => {
    const { workspace, module, add, item } = await setup(transaction, null, null);
    const workItem = await item();
    await add([workItem.id]);
    const found = await transaction.select({ id: moduleHistory.id }).from(moduleHistory).where(eq(moduleHistory.moduleId, module.id));
    expect(found.length).toBeGreaterThan(0);
    // This exercises the cascading delete path through workspace -> project -> module.
    await transaction.execute((await import("drizzle-orm")).sql`DELETE FROM workspaces WHERE id = ${workspace.id}`);
    expect(await transaction.select().from(moduleHistory).where(eq(moduleHistory.moduleId, module.id))).toEqual([]);
  });
});

test.concurrent("deleting a work item keeps its anonymous historical Module counts", async () => {
  await withRollback(db, async (transaction) => {
    const { modules, module, as, add, work, project } = await setup(transaction, day(-3), day(-1));
    const itemTitle = "Private deleted title";
    const workItem = await work.createWorkItem.handler(as, { projectId: project.id, title: itemTitle });
    await add([workItem.id]);
    await transaction.update(moduleTable).set({ historyStartedAt: at(day(-4)) }).where(eq(moduleTable.id, module.id));
    const event = (await transaction.select().from(moduleHistory).where(eq(moduleHistory.moduleId, module.id)))[0]!;
    await transaction.update(moduleHistory).set({ occurredAt: at(day(-2)) }).where(eq(moduleHistory.id, event.id));
    await work.deleteWorkItem.handler(as, { workItemId: workItem.id });

    const report = await modules.getModuleBurndown.handler(as, { moduleId: module.id });
    expect(report.days.map((point) => point.open)).toEqual([0, 1, 1]);
    expect(JSON.stringify(report)).not.toContain(itemTitle);
    await transaction.delete(workItems).where(eq(workItems.id, workItem.id));
    const afterHardDelete = await modules.getModuleBurndown.handler(as, { moduleId: module.id });
    expect(afterHardDelete.days.map((point) => point.open)).toEqual([0, 1, 1]);
    expect(JSON.stringify(afterHardDelete)).not.toContain(workItem.id);
  });
});

test.concurrent("archiving work does not rewrite its historical Module membership", async () => {
  await withRollback(db, async (transaction) => {
    const { modules, module, as, item, add } = await setup(transaction, day(-1), day(0));
    const live = await item(), archived = await item();
    await add([live.id, archived.id]);
    await transaction.update(workItems).set({ archivedAt: new Date() }).where(eq(workItems.id, archived.id));
    await transaction.update(moduleTable).set({ historyStartedAt: at(day(-3)) }).where(eq(moduleTable.id, module.id));
    const history = await transaction.select().from(moduleHistory).where(eq(moduleHistory.moduleId, module.id));
    for (const event of history) await transaction.update(moduleHistory).set({ occurredAt: at(day(-2), "12:00:00") }).where(eq(moduleHistory.id, event.id));
    const result = await modules.getModuleBurndown.handler(as, { moduleId: module.id });
    expect(result.total).toBe(2);
    expect(result.days.map((point) => point.open)).toEqual([2, null]);
  });
});

test.concurrent("permissions follow project membership", async () => {
  await withRollback(db, async (transaction) => {
    const { modules, module, outsider } = await setup(transaction, day(-1), day(0));
    await expect(modules.getModuleBurndown.handler({ userId: outsider.id }, { moduleId: module.id })).rejects.toMatchObject({ status: 404 });
  });
});

test("the Action is a Read action in the registry", () => {
  expect(createActionList(db).find((candidate) => candidate.name === "get_module_burndown")?.kind).toBe("read");
});
