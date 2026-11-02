import { afterAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createDatabase, workItems, type Database } from "@weft/db";
import { createActionList, createModuleActions, createProjectActions, createWorkItemActions } from "../src";
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
  const item = async (completedAt: Date | null = null) => {
    const created = await work.createWorkItem.handler(as, { projectId: project.id, title: "Item" });
    await transaction.update(workItems).set({ completedAt, createdAt: at("2020-01-01") }).where(eq(workItems.id, created.id));
    return created;
  };
  return { outsider, modules, module, as, item, add: (ids: string[]) => modules.addModuleItems.handler(as, { moduleId: module.id, workItemIds: ids }) };
}

test.concurrent("exact day series, ideal line and null future days", async () => {
  await withRollback(db, async (transaction) => {
    const { modules, module, as, item, add } = await setup(transaction, day(-3), day(1));
    const a = await item(at(day(-2))), b = await item(at(day(-1), "00:00:00")), c = await item(), d = await item();
    await add([a.id, b.id, c.id, d.id]);
    const result = await modules.getModuleBurndown.handler(as, { moduleId: module.id });
    expect(result).toMatchObject({ moduleId: module.id, startDate: day(-3), endDate: day(1), total: 4, reason: null });
    expect(result.days).toEqual([
      { date: day(-3), open: 4, ideal: 4 },
      { date: day(-2), open: 3, ideal: 3 },
      { date: day(-1), open: 2, ideal: 2 },
      { date: day(0), open: 2, ideal: 1 },
      { date: day(1), open: null, ideal: 0 },
    ]);
  });
});

test.concurrent("missing start date, target date or work items gives a reason and no days", async () => {
  await withRollback(db, async (transaction) => {
    const noStart = await setup(transaction, null, day(1));
    await noStart.add([(await noStart.item()).id]);
    expect(await noStart.modules.getModuleBurndown.handler(noStart.as, { moduleId: noStart.module.id })).toMatchObject({ reason: "missing_start_date", days: [], total: 1 });
    const noEnd = await setup(transaction, day(-1), null);
    await noEnd.add([(await noEnd.item()).id]);
    expect(await noEnd.modules.getModuleBurndown.handler(noEnd.as, { moduleId: noEnd.module.id })).toMatchObject({ reason: "missing_target_date", days: [] });
    const empty = await setup(transaction, day(-1), day(1));
    expect(await empty.modules.getModuleBurndown.handler(empty.as, { moduleId: empty.module.id })).toMatchObject({ reason: "no_work_items", days: [], total: 0 });
  });
});

test.concurrent("archived items are left out of the total", async () => {
  await withRollback(db, async (transaction) => {
    const { modules, module, as, item, add } = await setup(transaction, day(-1), day(0));
    const live = await item(), archived = await item();
    await add([live.id, archived.id]);
    await transaction.update(workItems).set({ archivedAt: new Date() }).where(eq(workItems.id, archived.id));
    const result = await modules.getModuleBurndown.handler(as, { moduleId: module.id });
    expect(result.total).toBe(1);
    expect(result.days.map((point) => point.open)).toEqual([1, 1]);
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
