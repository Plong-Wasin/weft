import { afterAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createDatabase, cycleHistory, cycles as cycleRows, workItemStates, workItems, type Database } from "@weft/db";
import { burndownSeries, createCycleActions, createProjectActions, createWorkItemActions, createActionList } from "../src";
import { createMemberFactory, createWorkspaceFactory, withRollback } from "../../db/src/test-helpers";

const { client, db } = createDatabase();
afterAll(async () => client.end());

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const at = (date: string, time = "12:00:00") => new Date(`${date}T${time}Z`);

async function setup(transaction: Database, startDate: string, endDate: string) {
  const workspace = await createWorkspaceFactory(transaction);
  const admin = await createMemberFactory(transaction, workspace.id, "Admin");
  const outsider = await createMemberFactory(transaction, workspace.id, "Member");
  const projects = createProjectActions(transaction);
  const project = await projects.createProject.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Mobile", key: "MOB", visibility: "private" });
  const work = createWorkItemActions(transaction);
  const cycles = createCycleActions(transaction);
  const cycle = await cycles.createCycle.handler({ userId: admin.id }, { projectId: project.id, name: "Sprint", startDate, endDate });
  const as = { userId: admin.id };
  const item = async (completedAt: Date | null = null) => {
    const created = await work.createWorkItem.handler(as, { projectId: project.id, title: "Item" });
    await transaction.update(workItems).set({ completedAt }).where(eq(workItems.id, created.id));
    await transaction.update(workItems).set({ createdAt: at("2020-01-01") }).where(eq(workItems.id, created.id));
    return created;
  };
  return { admin, outsider, project, cycles, cycle, as, item, add: (ids: string[]) => cycles.addCycleItems.handler(as, { cycleId: cycle.id, workItemIds: ids }), transaction };
}

test("burndownSeries uses calendar days for the ideal line", () => {
  const { total, days } = burndownSeries("2026-03-01", "2026-03-05", [null, null, null, null], "2026-03-05");
  expect(total).toBe(4);
  expect(days.map((point) => point.ideal)).toEqual([4, 3, 2, 1, 0]);
  expect(burndownSeries("2026-03-01", "2026-03-01", [null], "2026-03-01").days).toEqual([{ date: "2026-03-01", open: 1, ideal: 0 }]);
});

test.concurrent("legacy and backdated Cycle days disclose unknown history", async () => {
  await withRollback(db, async (transaction) => {
    const { cycles, cycle, as } = await setup(transaction, day(-3), day(1));
    const result = await cycles.getCycleBurndown.handler(as, { cycleId: cycle.id });
    expect(result).toMatchObject({ cycleId: cycle.id, startDate: day(-3), endDate: day(1), initialScope: null });
    expect(result.days.filter((point) => point.date <= day(0)).every((point) => point.unknown && point.open === null)).toBe(true);
    expect(result.days.at(-1)?.open).toBeNull();
  });
});

test.concurrent("Action burndown replays completion, reopening and cancellation at UTC day ends", async () => {
  await withRollback(db, async (transaction) => {
    const { cycles, cycle, as, item, add, project, transaction: tx } = await setup(transaction, day(-2), day(1));
    const reopened = await item(null);
    const cancelled = await item(null);
    await add([reopened.id, cancelled.id]);
    await tx.update(cycleRows).set({ createdAt: at(day(-4)), historyStartedAt: at(day(-4)), endDate: day(-1) }).where(eq(cycleRows.id, cycle.id));
    await transaction.update(cycleHistory).set({ occurredAt: at(day(-2)) }).where(eq(cycleHistory.cycleId, cycle.id));
    const states = await transaction.select().from(workItemStates).where(eq(workItemStates.projectId, project.id));
    await transaction.update(workItems).set({ stateId: states.find((state) => state.group === "cancelled")!.id }).where(eq(workItems.id, cancelled.id));
    const cancelledEvent = await transaction.select().from(cycleHistory).where(eq(cycleHistory.workItemId, cancelled.id));
    await transaction.update(cycleHistory).set({ occurredAt: at(day(-1), "10:00:00") }).where(eq(cycleHistory.id, cancelledEvent.at(-1)!.id));
    const completed = states.find((state) => state.group === "completed")!;
    await transaction.update(workItems).set({ stateId: completed.id }).where(eq(workItems.id, reopened.id));
    const completedEvent = (await transaction.select().from(cycleHistory).where(eq(cycleHistory.workItemId, reopened.id))).at(-1)!;
    await transaction.update(cycleHistory).set({ occurredAt: at(day(-1), "11:00:00") }).where(eq(cycleHistory.id, completedEvent.id));
    await transaction.update(workItems).set({ stateId: states.find((state) => state.group === "started")!.id }).where(eq(workItems.id, reopened.id));
    const reopenedEvent = (await transaction.select().from(cycleHistory).where(eq(cycleHistory.workItemId, reopened.id))).at(-1)!;
    await transaction.update(cycleHistory).set({ occurredAt: at(day(-1), "12:00:00") }).where(eq(cycleHistory.id, reopenedEvent.id));
    const result = await cycles.getCycleBurndown.handler(as, { cycleId: cycle.id });
    expect(result.days.map((point) => [point.open, point.completed, point.cancelled])).toEqual([[2, 0, 0], [1, 0, 1]]);
    expect(result.finalOutcome).toEqual({ completed: 0, open: 1, cancelled: 1 });
    const target = await cycles.createCycle.handler(as, { projectId: project.id, name: "Next", startDate: day(1), endDate: day(4) });
    await cycles.transferCycleItems.handler(as, { cycleId: cycle.id, targetCycleId: target.id });
    expect((await cycles.getCycleBurndown.handler(as, { cycleId: cycle.id })).finalOutcome).toEqual(result.finalOutcome);
    await tx.delete(workItems).where(eq(workItems.id, reopened.id));
    const afterDelete = await cycles.getCycleBurndown.handler(as, { cycleId: cycle.id });
    expect(afterDelete.finalOutcome).toEqual(result.finalOutcome);
    expect(JSON.stringify(afterDelete)).not.toContain(reopened.id);
  });
});

test.concurrent("archived and Triage items are left out of the total and the series", async () => {
  await withRollback(db, async (transaction) => {
    const { cycles, cycle, as, item, add, transaction: tx } = await setup(transaction, day(0), day(0));
    const live = await item(), archived = await item(), triaged = await item();
    await add([live.id, archived.id, triaged.id]);
    await tx.update(workItems).set({ archivedAt: new Date() }).where(eq(workItems.id, archived.id));
    const [row] = await tx.select({ projectId: workItems.projectId }).from(workItems).where(eq(workItems.id, triaged.id));
    const triageState = (await tx.select().from(workItemStates).where(eq(workItemStates.projectId, row!.projectId))).find((candidate) => candidate.group === "triage")!;
    await tx.update(workItems).set({ stateId: triageState.id }).where(eq(workItems.id, triaged.id));
    const result = await cycles.getCycleBurndown.handler(as, { cycleId: cycle.id });
    expect(result.days.every((point) => point.unknown && point.open === null)).toBe(true);
  });
});

test.concurrent("permissions follow project membership", async () => {
  await withRollback(db, async (transaction) => {
    const { cycles, cycle, outsider } = await setup(transaction, day(-1), day(0));
    await expect(cycles.getCycleBurndown.handler({ userId: outsider.id }, { cycleId: cycle.id })).rejects.toMatchObject({ status: 404 });
  });
});

test("the Action is a Read action in the registry", () => {
  const action = createActionList(db).find((candidate) => candidate.name === "get_cycle_burndown");
  expect(action?.kind).toBe("read");
});
