import { afterAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createDatabase, workItemStates, workItems, type Database } from "@weft/db";
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

test.concurrent("exact day series, ideal line and null future days", async () => {
  await withRollback(db, async (transaction) => {
    const { cycles, cycle, as, item, add } = await setup(transaction, day(-3), day(1));
    const a = await item(at(day(-2))), b = await item(at(day(-1), "00:00:00")), c = await item(), d = await item();
    await add([a.id, b.id, c.id, d.id]);
    const result = await cycles.getCycleBurndown.handler(as, { cycleId: cycle.id });
    expect(result).toMatchObject({ cycleId: cycle.id, startDate: day(-3), endDate: day(1), total: 4 });
    expect(result.days).toEqual([
      { date: day(-3), open: 4, ideal: 4 },
      { date: day(-2), open: 3, ideal: 3 },
      { date: day(-1), open: 2, ideal: 2 },
      { date: day(0), open: 2, ideal: 1 },
      { date: day(1), open: null, ideal: 0 },
    ]);
  });
});

test.concurrent("a reopened item counts as open, a cancelled item is never done", async () => {
  await withRollback(db, async (transaction) => {
    const { cycles, cycle, as, item, add } = await setup(transaction, day(-2), day(0));
    const reopened = await item(null);
    const cancelled = await item(null);
    await add([reopened.id, cancelled.id]);
    expect((await cycles.getCycleBurndown.handler(as, { cycleId: cycle.id })).days.map((point) => point.open)).toEqual([2, 2, 2]);
  });
});

test.concurrent("archived and Triage items are left out of the total and the series", async () => {
  await withRollback(db, async (transaction) => {
    const { cycles, cycle, as, item, add, transaction: tx } = await setup(transaction, day(-1), day(0));
    const live = await item(), archived = await item(), triaged = await item();
    await add([live.id, archived.id, triaged.id]);
    await tx.update(workItems).set({ archivedAt: new Date() }).where(eq(workItems.id, archived.id));
    const [row] = await tx.select({ projectId: workItems.projectId }).from(workItems).where(eq(workItems.id, triaged.id));
    const triageState = (await tx.select().from(workItemStates).where(eq(workItemStates.projectId, row!.projectId))).find((candidate) => candidate.group === "triage")!;
    await tx.update(workItems).set({ stateId: triageState.id }).where(eq(workItems.id, triaged.id));
    const result = await cycles.getCycleBurndown.handler(as, { cycleId: cycle.id });
    expect(result.total).toBe(1);
    expect(result.days.map((point) => point.open)).toEqual([1, 1]);
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
