import { afterAll, expect, test } from "bun:test";
import { createDatabase, type Database } from "@weft/db";
import { createCycleActions, createModuleActions, createProjectActions, createWorkItemActions } from "../src";
import { createMemberFactory, createWorkspaceFactory, withRollback } from "../../db/src/test-helpers";

const { client, db } = createDatabase();
afterAll(async () => client.end());

const day = (offset = 0) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

async function setup(transaction: Database) {
  const workspace = await createWorkspaceFactory(transaction);
  const admin = await createMemberFactory(transaction, workspace.id, "Admin");
  const member = await createMemberFactory(transaction, workspace.id, "Member");
  const outsider = await createMemberFactory(transaction, workspace.id, "Member");
  const projects = createProjectActions(transaction);
  const project = await projects.createProject.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Mobile", key: "MOB", visibility: "public" });
  await projects.addProjectMember.handler({ userId: admin.id }, { projectId: project.id, userId: member.id, role: "Member" });
  const work = createWorkItemActions(transaction);
  const cycles = createCycleActions(transaction);
  const modules = createModuleActions(transaction);
  const item = (title: string, projectId = project.id, userId = admin.id) => work.createWorkItem.handler({ userId }, { projectId, title });
  const cycle = (name: string, startDate: string, endDate: string, projectId = project.id) => cycles.createCycle.handler({ userId: admin.id }, { projectId, name, startDate, endDate });
  const module = (name: string, projectId = project.id) => modules.createModule.handler({ userId: admin.id }, { projectId, name });
  const query = async (text: string, extra: Record<string, unknown> = {}, userId = member.id) =>
    (await work.listWorkItems.handler({ userId }, { projectId: project.id, query: `${text} ORDER BY title`, ...extra })).map((row) => row.title);
  const error = (text: string, extra: Record<string, unknown> = {}) =>
    work.listWorkItems.handler({ userId: member.id }, { projectId: project.id, query: text, ...extra }).then(() => null, (caught: { status: number; message: string }) => caught);
  return { workspace, admin, member, outsider, projects, project, work, cycles, modules, item, cycle, module, query, error };
}

test.concurrent("cycle field: operators by name and activeCycle()", async () => {
  await withRollback(db, async (transaction) => {
    const env = await setup(transaction);
    const { cycles, item, cycle, query, admin } = env;
    const now = await cycle("Sprint Now", day(-2), day(3));
    const old = await cycle("Sprint Old", day(-30), day(-20));
    const next = await cycle("Sprint Next", day(10), day(20));
    const [a, b, c, d] = [await item("A"), await item("B"), await item("C"), await item("D")];
    await cycles.addCycleItems.handler({ userId: admin.id }, { cycleId: now.id, workItemIds: [a.id] });
    await cycles.addCycleItems.handler({ userId: admin.id }, { cycleId: next.id, workItemIds: [b.id] });
    await cycles.addCycleItems.handler({ userId: admin.id }, { cycleId: old.id, workItemIds: [c.id] }).catch(() => null);
    expect(await query("cycle = Sprint Now")).toEqual(["A"]);
    expect(await query('cycle = "sprint now"')).toEqual(["A"]);
    expect(await query("cycle != Sprint Now")).toEqual(expect.arrayContaining(["B", "D"]));
    expect(await query("cycle != Sprint Now")).not.toContain("A");
    expect(await query("cycle IN (Sprint Now, Sprint Next)")).toEqual(["A", "B"]);
    expect(await query("cycle NOT IN (Sprint Now, Sprint Next)")).toEqual(["C", "D"]);
    expect(await query("cycle IS NULL")).toEqual(["C", "D"]);
    expect(await query("cycle IS NOT NULL")).toEqual(["A", "B"]);
    expect(await query("cycle = activeCycle()")).toEqual(["A"]);
    expect(await query("cycle IN (activeCycle())")).toEqual(["A"]);
    expect(await query("cycle != activeCycle() AND cycle IS NOT NULL")).toEqual(["B"]);
    expect(await query("cycle = Sprint Now OR cycle = Sprint Next")).toEqual(["A", "B"]);
    expect(d.title).toBe("D");
  });
});

test.concurrent("module field: many modules per item, operators by name", async () => {
  await withRollback(db, async (transaction) => {
    const env = await setup(transaction);
    const { modules, item, module, query, admin } = env;
    const auth = await module("Auth");
    const pay = await module("Payments");
    const [a, b, c] = [await item("A"), await item("B"), await item("C")];
    await modules.addModuleItems.handler({ userId: admin.id }, { moduleId: auth.id, workItemIds: [a.id, b.id] });
    await modules.addModuleItems.handler({ userId: admin.id }, { moduleId: pay.id, workItemIds: [b.id] });
    expect(await query("module = Auth")).toEqual(["A", "B"]);
    expect(await query("module = Payments")).toEqual(["B"]);
    expect(await query("module != Payments")).toEqual(["A", "C"]);
    expect(await query("module IN (Auth, Payments)")).toEqual(["A", "B"]);
    expect(await query("module NOT IN (Auth)")).toEqual(["C"]);
    expect(await query("module = Auth AND module = Payments")).toEqual(["B"]);
    expect(await query("module IS NULL")).toEqual(["C"]);
    expect(await query("module IS NOT NULL")).toEqual(["A", "B"]);
    expect(c.title).toBe("C");
  });
});

test.concurrent("a query in Cycle or Module scope is limited to that scope and never widens it", async () => {
  await withRollback(db, async (transaction) => {
    const env = await setup(transaction);
    const { cycles, modules, item, cycle, module, query, admin } = env;
    const one = await cycle("One", day(-1), day(5));
    const two = await cycle("Two", day(6), day(9));
    const auth = await module("Auth");
    const pay = await module("Payments");
    const [a, b, c] = [await item("A"), await item("B"), await item("C")];
    await cycles.addCycleItems.handler({ userId: admin.id }, { cycleId: one.id, workItemIds: [a.id] });
    await cycles.addCycleItems.handler({ userId: admin.id }, { cycleId: two.id, workItemIds: [b.id] });
    await modules.addModuleItems.handler({ userId: admin.id }, { moduleId: auth.id, workItemIds: [a.id, c.id] });
    await modules.addModuleItems.handler({ userId: admin.id }, { moduleId: pay.id, workItemIds: [b.id] });
    // The query ORs everything, yet the scope still holds.
    expect(await query("title ~ A OR title ~ B OR title ~ C", { cycleId: one.id })).toEqual(["A"]);
    expect(await query("cycle = Two", { cycleId: one.id })).toEqual([]);
    expect(await query("cycle = Two OR cycle = One", { cycleId: two.id })).toEqual(["B"]);
    expect(await query("NOT cycle = One", { cycleId: one.id })).toEqual([]);
    expect(await query("title ~ A OR title ~ B OR title ~ C", { moduleId: auth.id })).toEqual(["A", "C"]);
    expect(await query("module = Payments", { moduleId: auth.id })).toEqual([]);
    expect(await query("module IS NOT NULL", { moduleId: pay.id })).toEqual(["B"]);
    expect(await query("title ~ A OR title ~ B", { cycleId: one.id, moduleId: auth.id })).toEqual(["A"]);
    expect(await query("title ~ B", { cycleId: one.id, moduleId: pay.id })).toEqual([]);
  });
});

test.concurrent("names resolve inside the project: missing, duplicate, archived, deleted, other project", async () => {
  await withRollback(db, async (transaction) => {
    const env = await setup(transaction);
    const { admin, cycles, modules, projects, workspace, item, cycle, module, query, error } = env;
    const other = await projects.createProject.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Web", key: "WEB", visibility: "public" });
    const foreignCycle = await cycle("Foreign Cycle", day(-1), day(5), other.id);
    const foreignModule = await module("Foreign Module", other.id);
    const foreignItem = await item("Foreign", other.id);
    await cycles.addCycleItems.handler({ userId: admin.id }, { cycleId: foreignCycle.id, workItemIds: [foreignItem.id] });
    await modules.addModuleItems.handler({ userId: admin.id }, { moduleId: foreignModule.id, workItemIds: [foreignItem.id] });
    await item("Mine");

    // No leak across projects: a name that exists only in another project is missing, an id of one too.
    expect(await error("cycle = Foreign Cycle")).toMatchObject({ status: 400, message: expect.stringContaining('cycle "Foreign Cycle" was not found') });
    expect(await error("module = Foreign Module")).toMatchObject({ status: 400, message: expect.stringContaining('module "Foreign Module" was not found') });
    expect(await error(`cycle = ${foreignCycle.id}`)).toMatchObject({ status: 400 });
    expect(await error(`module IN (${foreignModule.id})`)).toMatchObject({ status: 400 });
    expect(await error("cycle = Nope")).toMatchObject({ status: 400, message: expect.stringContaining("position 8") });

    // The same name in two projects does not collide; a duplicate inside one project does.
    const same = await cycle("Same", day(-1), day(5));
    await cycle("Same", day(6), day(9), other.id);
    expect(await query("cycle = Same")).toEqual([]);
    await cycle("Same", day(10), day(12));
    expect(await error("cycle = Same")).toMatchObject({ status: 400, message: expect.stringContaining("ambiguous") });
    expect(await error("cycle IN (Same, Mine)")).toMatchObject({ status: 400 });
    expect(same.name).toBe("Same");
    await module("Twin");
    await module("Twin");
    expect(await error("module = Twin")).toMatchObject({ status: 400, message: expect.stringContaining("ambiguous") });

    // Archived and deleted Cycles and Modules resolve as missing.
    const done = await cycle("Done Cycle", day(-20), day(-10));
    await cycles.archiveCycle.handler({ userId: admin.id }, { cycleId: done.id });
    expect(await error("cycle = Done Cycle")).toMatchObject({ status: 400, message: expect.stringContaining("was not found") });
    const gone = await cycle("Gone Cycle", day(20), day(30));
    await cycles.deleteCycle.handler({ userId: admin.id }, { cycleId: gone.id });
    expect(await error("cycle = Gone Cycle")).toMatchObject({ status: 400, message: expect.stringContaining("was not found") });
    const finished = await module("Finished");
    await modules.updateModule.handler({ userId: admin.id }, { moduleId: finished.id, status: "completed" });
    await modules.archiveModule.handler({ userId: admin.id }, { moduleId: finished.id });
    expect(await error("module = Finished")).toMatchObject({ status: 400, message: expect.stringContaining("was not found") });
    const dropped = await module("Dropped");
    await modules.deleteModule.handler({ userId: admin.id }, { moduleId: dropped.id });
    expect(await error("module = Dropped")).toMatchObject({ status: 400, message: expect.stringContaining("was not found") });
  });
});

test.concurrent("activeCycle() ignores other projects, archived and deleted Cycles, and may match none or several", async () => {
  await withRollback(db, async (transaction) => {
    const env = await setup(transaction);
    const { admin, cycles, projects, workspace, item, cycle, query } = env;
    const other = await projects.createProject.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Web", key: "WEB", visibility: "public" });
    const foreign = await cycle("Foreign Now", day(-1), day(5), other.id);
    const foreignItem = await item("Foreign", other.id);
    await cycles.addCycleItems.handler({ userId: admin.id }, { cycleId: foreign.id, workItemIds: [foreignItem.id] });
    const mine = await item("Mine");
    expect(await query("cycle = activeCycle()")).toEqual([]);
    expect(await query("cycle != activeCycle()")).toEqual(["Mine"]);
    const first = await cycle("First", day(-1), day(5));
    const second = await cycle("Second", day(0), day(2));
    const other2 = await item("Other");
    await cycles.addCycleItems.handler({ userId: admin.id }, { cycleId: first.id, workItemIds: [mine.id] });
    await cycles.addCycleItems.handler({ userId: admin.id }, { cycleId: second.id, workItemIds: [other2.id] });
    expect(await query("cycle = activeCycle()")).toEqual(["Mine", "Other"]);
    await cycles.deleteCycle.handler({ userId: admin.id }, { cycleId: second.id });
    expect(await query("cycle = activeCycle()")).toEqual(["Mine"]);
    expect(await query("cycle IS NOT NULL")).toEqual(["Mine"]);
  });
});

test.concurrent("a query naming Cycles or Modules is a 400 when that feature is off; other queries still work", async () => {
  await withRollback(db, async (transaction) => {
    const env = await setup(transaction);
    const { admin, projects, project, item, query, error } = env;
    await item("A");
    await projects.setProjectFeatures.handler({ userId: admin.id }, { projectId: project.id, features: { cycles: false } });
    for (const text of ["cycle = X", "cycle IS NULL", "cycle != X", "cycle = activeCycle()", "title ~ A AND cycle IS NOT NULL"]) {
      expect(await error(text), text).toMatchObject({ status: 400, message: expect.stringContaining("Cycles are turned off") });
    }
    expect(await query("module IS NULL")).toEqual(["A"]);
    expect(await query("title ~ A")).toEqual(["A"]);
    await projects.setProjectFeatures.handler({ userId: admin.id }, { projectId: project.id, features: { cycles: true, modules: false } });
    for (const text of ["module = X", "module IS NULL", "module NOT IN (X)"]) {
      expect(await error(text), text).toMatchObject({ status: 400, message: expect.stringContaining("Modules are turned off") });
    }
    expect(await query("cycle IS NULL")).toEqual(["A"]);
  });
});

test.concurrent("private project: no access means no query, and fields do not widen access", async () => {
  await withRollback(db, async (transaction) => {
    const env = await setup(transaction);
    const { admin, workspace, projects, work, outsider } = env;
    const secret = await projects.createProject.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Secret", key: "SEC", visibility: "private" });
    await work.createWorkItem.handler({ userId: admin.id }, { projectId: secret.id, title: "Hidden" });
    await expect(work.listWorkItems.handler({ userId: outsider.id }, { projectId: secret.id, query: "cycle IS NULL" })).rejects.toMatchObject({ status: 404 });
  });
});

test.concurrent("search_work_items pql accepts cycle and module", async () => {
  await withRollback(db, async (transaction) => {
    const env = await setup(transaction);
    const { admin, member, cycles, item, cycle, project, workspace } = env;
    const { createSearchActions } = await import("../src");
    const search = createSearchActions(transaction);
    const sprint = await cycle("Sprint", day(-1), day(5));
    const a = await item("Alpha");
    await item("Beta");
    await cycles.addCycleItems.handler({ userId: admin.id }, { cycleId: sprint.id, workItemIds: [a.id] });
    const hits = await search.searchWorkItems.handler({ userId: member.id }, { workspaceId: workspace.id, projectId: project.id, pql: "cycle = activeCycle()" });
    expect(JSON.stringify(hits)).toContain("Alpha");
    expect(JSON.stringify(hits)).not.toContain("Beta");
  });
});
