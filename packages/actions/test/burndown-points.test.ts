import { afterAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createDatabase, workItems, type Database } from "@weft/db";
import { createAnalyticsActions, createCycleActions, createEstimateActions, createModuleActions, createProjectActions, createWorkItemActions } from "../src";
import { createMemberFactory, createWorkspaceFactory, withRollback } from "../../db/src/test-helpers";

const { client, db } = createDatabase();
afterAll(async () => client.end());

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const at = (date: string, time = "12:00:00") => new Date(`${date}T${time}Z`);
const status = (promise: Promise<unknown>) => promise.then(() => 200, (error: { status?: number }) => error.status ?? 500);

async function setup(transaction: Database, estimate: { type: "points" | "categories"; values: string[] } | null) {
  const workspace = await createWorkspaceFactory(transaction);
  const admin = await createMemberFactory(transaction, workspace.id, "Admin");
  const as = { userId: admin.id };
  const project = await createProjectActions(transaction).createProject.handler(as, { workspaceId: workspace.id, name: "Mobile", key: "MOB", visibility: "private" });
  const estimates = createEstimateActions(transaction);
  const created = estimate ? await estimates.createEstimate.handler(as, { projectId: project.id, ...estimate }) : null;
  const work = createWorkItemActions(transaction);
  const cycles = createCycleActions(transaction);
  const modules = createModuleActions(transaction);
  const cycle = await cycles.createCycle.handler(as, { projectId: project.id, name: "Sprint", startDate: day(-2), endDate: day(0) });
  const module = await modules.createModule.handler(as, { projectId: project.id, name: "Topic", startDate: day(-2), endDate: day(0) });
  const item = async (value: string | null, completedAt: Date | null = null) => {
    const point = created?.points.find((entry) => entry.value === value);
    const row = await work.createWorkItem.handler(as, { projectId: project.id, title: "Item", ...(point ? { estimatePointId: point.id } : {}) });
    await transaction.update(workItems).set({ completedAt, createdAt: at("2020-01-01") }).where(eq(workItems.id, row.id));
    await cycles.addCycleItems.handler(as, { cycleId: cycle.id, workItemIds: [row.id] });
    await modules.addModuleItems.handler(as, { moduleId: module.id, workItemIds: [row.id] });
    return row;
  };
  return { workspace, as, project, cycles, cycle, modules, module, item, estimates, analytics: createAnalyticsActions(transaction) };
}

test.concurrent("points mode sums Estimate points; unsized items count zero", async () => {
  await withRollback(db, async (transaction) => {
    const { as, cycles, cycle, modules, module, item } = await setup(transaction, { type: "points", values: ["1", "2", "5"] });
    await item("5", at(day(-1)));
    await item("2");
    await item(null);
    await item("1", at(day(0), "00:00:00"));
    const expected = [
      { date: day(-2), open: 8, ideal: 8 },
      { date: day(-1), open: 3, ideal: 4 },
      { date: day(0), open: 2, ideal: 0 },
    ];
    const byCycle = await cycles.getCycleBurndown.handler(as, { cycleId: cycle.id, unit: "points" });
    expect(byCycle).toMatchObject({ unit: "points", total: 8 });
    expect(byCycle.days).toEqual(expected);
    const byModule = await modules.getModuleBurndown.handler(as, { moduleId: module.id, unit: "points" });
    expect(byModule).toMatchObject({ unit: "points", total: 8, reason: null });
    expect(byModule.days).toEqual(expected);
    // Work items mode is unchanged.
    const items = await cycles.getCycleBurndown.handler(as, { cycleId: cycle.id });
    expect(items).toMatchObject({ unit: "items", total: 4 });
    expect(items.days.map((point) => point.open)).toEqual([4, 3, 2]);
  });
});

test.concurrent("points mode is refused without a points Estimate (categories, none, or turned off)", async () => {
  await withRollback(db, async (transaction) => {
    for (const estimate of [{ type: "categories" as const, values: ["S", "M"] }, null]) {
      const { as, cycles, cycle, modules, module, item } = await setup(transaction, estimate);
      await item(null);
      expect(await status(cycles.getCycleBurndown.handler(as, { cycleId: cycle.id, unit: "points" }))).toBe(400);
      expect(await status(modules.getModuleBurndown.handler(as, { moduleId: module.id, unit: "points" }))).toBe(400);
      await expect(cycles.getCycleBurndown.handler(as, { cycleId: cycle.id, unit: "points" })).rejects.toThrow(/points Estimate/);
    }
    const off = await setup(transaction, { type: "points", values: ["1", "2"] });
    await off.estimates.updateEstimate.handler(off.as, { projectId: off.project.id, enabled: false });
    expect(await status(off.cycles.getCycleBurndown.handler(off.as, { cycleId: off.cycle.id, unit: "points" }))).toBe(400);
  });
});

test.concurrent("Estimate point axis groups points by value and categories by label, none last", async () => {
  await withRollback(db, async (transaction) => {
    const points = await setup(transaction, { type: "points", values: ["1", "2", "10"] });
    await points.item("10"); await points.item("2"); await points.item("2"); await points.item(null);
    const byPoint = await points.analytics.getAnalyticsInsights.handler(points.as, { workspaceId: points.workspace.id, x: "estimatePoint" });
    expect(byPoint.buckets.map((bucket) => [bucket.key, bucket.count])).toEqual([["2", 2], ["10", 1], [null, 1]]);
    const split = await points.analytics.getAnalyticsInsights.handler(points.as, { workspaceId: points.workspace.id, x: "stateGroup", groupBy: "estimatePoint" });
    expect(split.buckets[0]!.groups.map((group) => [group.key, group.count])).toEqual([["2", 2], ["10", 1], [null, 1]]);
    const categories = await setup(transaction, { type: "categories", values: ["Small", "Large"] });
    await categories.item("Small"); await categories.item("Large"); await categories.item("Large");
    const byLabel = await categories.analytics.getAnalyticsInsights.handler(categories.as, { workspaceId: categories.workspace.id, projectIds: [categories.project.id], x: "estimatePoint" });
    expect(byLabel.buckets.map((bucket) => [bucket.key, bucket.label, bucket.count])).toEqual([["Large", "Large", 2], ["Small", "Small", 1]]);
  });
});
