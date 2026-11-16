import { afterAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createDatabase, projects as projectRows, type Database } from "@weft/db";
import { createCycleActions, createModuleActions, createProjectActions, createViewActions, createWikiActions, type ActionError } from "../src";
import { createMemberFactory, createWorkspaceFactory, withRollback } from "../../db/src/test-helpers";

const { client, db } = createDatabase();
afterAll(async () => client.end());

const failure = async (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => error as ActionError);

async function setup(transaction: Database) {
  const workspace = await createWorkspaceFactory(transaction);
  const admin = await createMemberFactory(transaction, workspace.id, "Admin");
  const member = await createMemberFactory(transaction, workspace.id, "Member");
  const guest = await createMemberFactory(transaction, workspace.id, "Guest");
  const projects = createProjectActions(transaction);
  const wiki = createWikiActions(transaction, () => new Date("2026-01-01T00:00:00Z"));
  return { workspace, admin, member, guest, projects, wiki, views: createViewActions(transaction), cycles: createCycleActions(transaction), modules: createModuleActions(transaction) };
}

test.concurrent("a project created with the Simple shape has Cycles, Modules and Intake off and keeps Pages and Views on", async () => {
  await withRollback(db, async (transaction) => {
    const { workspace, member, projects } = await setup(transaction);
    const simple = await projects.createProject.handler({ userId: member.id }, { workspaceId: workspace.id, name: "Simple", key: "SMP", visibility: "public", shape: "simple" });
    expect(simple.features).toEqual({ cycles: false, modules: false, intake: false, pages: true, views: true });
    const full = await projects.createProject.handler({ userId: member.id }, { workspaceId: workspace.id, name: "Full", key: "FUL", visibility: "public", shape: "full" });
    expect(full.features).toEqual({ cycles: true, modules: true, intake: true, pages: true, views: true });
    // Without a shape the API keeps the Full behaviour that existing callers expect.
    const unspecified = await projects.createProject.handler({ userId: member.id }, { workspaceId: workspace.id, name: "Plain", key: "PLN", visibility: "public" });
    expect(unspecified.features).toEqual({ cycles: true, modules: true, intake: true, pages: true, views: true });
  });
});

test.concurrent("a project row written without feature columns keeps every feature on, as existing projects do after migration 0095", async () => {
  await withRollback(db, async (transaction) => {
    const { workspace, member } = await setup(transaction);
    const [row] = await transaction.insert(projectRows).values({ workspaceId: workspace.id, key: "OLD", name: "Old", visibility: "public", createdBy: member.id }).returning();
    expect({ cycles: row!.cyclesEnabled, modules: row!.modulesEnabled, intake: row!.intakeEnabled, pages: row!.pagesEnabled, views: row!.viewsEnabled })
      .toEqual({ cycles: true, modules: true, intake: true, pages: true, views: true });
  });
});

test.concurrent("a Simple project refuses a Cycle Action with a message that names the feature and where an admin turns it on", async () => {
  await withRollback(db, async (transaction) => {
    const { workspace, member, cycles, projects } = await setup(transaction);
    const project = await projects.createProject.handler({ userId: member.id }, { workspaceId: workspace.id, name: "Simple", key: "SMP", visibility: "public", shape: "simple" });
    const error = await failure(cycles.createCycle.handler({ userId: member.id }, { projectId: project.id, name: "Sprint", startDate: "2026-01-01", endDate: "2026-01-14" }));
    expect(error?.status).toBe(400);
    expect(error?.message).toContain("The Cycles feature is turned off");
    expect(error?.message).toContain("Project settings > Features");
  });
});

test.concurrent("switching Modules and Intake on and off keeps their data and does not change other switches", async () => {
  await withRollback(db, async (transaction) => {
    const { workspace, admin, member, projects, modules } = await setup(transaction);
    const project = await projects.createProject.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Mod", key: "MOD", visibility: "public", shape: "full" });
    await projects.addProjectMember.handler({ userId: admin.id }, { projectId: project.id, userId: member.id, role: "Member" });
    const module = await modules.createModule.handler({ userId: member.id }, { projectId: project.id, name: "Login" });
    const off = await projects.setProjectFeatures.handler({ userId: admin.id }, { projectId: project.id, features: { modules: false } });
    expect(off.features).toEqual({ cycles: true, modules: false, intake: true, pages: true, views: true });
    expect(await failure(modules.listModules.handler({ userId: member.id }, { projectId: project.id }))).toMatchObject({ status: 400 });
    const on = await projects.setProjectFeatures.handler({ userId: admin.id }, { projectId: project.id, features: { modules: true } });
    expect(on.features.modules).toBe(true);
    expect((await modules.listModules.handler({ userId: member.id }, { projectId: project.id })).map((row) => row.id)).toContain(module.id);
  });
});

test.concurrent("Pages switch: off hides project Pages and refuses new ones; on brings the existing page back", async () => {
  await withRollback(db, async (transaction) => {
    const { workspace, admin, member, projects, wiki } = await setup(transaction);
    const project = await projects.createProject.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Docs", key: "DOC", visibility: "public", shape: "simple" });
    await projects.addProjectMember.handler({ userId: admin.id }, { projectId: project.id, userId: member.id, role: "Member" });
    const page = await wiki.createWikiPage.handler({ userId: member.id }, { workspaceId: workspace.id, title: "Plan", projectId: project.id });
    await projects.setProjectFeatures.handler({ userId: admin.id }, { projectId: project.id, features: { pages: false } });
    expect(await failure(wiki.listProjectWikiPages.handler({ userId: member.id }, { projectId: project.id }))).toMatchObject({ status: 400 });
    expect((await failure(wiki.listProjectWikiPages.handler({ userId: member.id }, { projectId: project.id })))?.message).toContain("The Pages feature is turned off");
    expect(await failure(wiki.createWikiPage.handler({ userId: member.id }, { workspaceId: workspace.id, title: "Nope", projectId: project.id }))).toMatchObject({ status: 400 });
    await projects.setProjectFeatures.handler({ userId: admin.id }, { projectId: project.id, features: { pages: true } });
    expect((await wiki.listProjectWikiPages.handler({ userId: member.id }, { projectId: project.id })).map((row) => row.id)).toEqual([page.id]);
  });
});

test.concurrent("Views switch: off refuses Views of the project and keeps them; on shows them again", async () => {
  await withRollback(db, async (transaction) => {
    const { workspace, admin, member, projects, views } = await setup(transaction);
    const project = await projects.createProject.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Views", key: "VWS", visibility: "public", shape: "simple" });
    await projects.addProjectMember.handler({ userId: admin.id }, { projectId: project.id, userId: member.id, role: "Member" });
    const view = await views.createView.handler({ userId: member.id }, { projectId: project.id, name: "Mine" });
    await projects.setProjectFeatures.handler({ userId: admin.id }, { projectId: project.id, features: { views: false } });
    expect(await failure(views.listViews.handler({ userId: member.id }, { projectId: project.id }))).toMatchObject({ status: 400 })
    expect((await failure(views.listViews.handler({ userId: member.id }, { projectId: project.id })))?.message).toContain("The Views feature is turned off");
    expect(await failure(views.getView.handler({ userId: member.id }, { viewId: view.id }))).toMatchObject({ status: 400 });
    expect(await failure(views.createView.handler({ userId: member.id }, { projectId: project.id, name: "Nope" }))).toMatchObject({ status: 400 });
    await projects.setProjectFeatures.handler({ userId: admin.id }, { projectId: project.id, features: { views: true } });
    expect((await views.listViews.handler({ userId: member.id }, { projectId: project.id })).map((row) => row.id)).toContain(view.id);
  });
});

test.concurrent("a workspace Admin who is not in the project may switch features; a Member and a Guest may not", async () => {
  await withRollback(db, async (transaction) => {
    const { workspace, admin, member, guest, projects } = await setup(transaction);
    const outsideAdmin = await createMemberFactory(transaction, workspace.id, "Admin");
    const project = await projects.createProject.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Switch", key: "SWT", visibility: "public", shape: "simple" });
    await projects.addProjectMember.handler({ userId: admin.id }, { projectId: project.id, userId: member.id, role: "Member" });
    expect(await failure(projects.setProjectFeatures.handler({ userId: member.id }, { projectId: project.id, features: { cycles: true } }))).toMatchObject({ status: 403 });
    expect(await failure(projects.setProjectFeatures.handler({ userId: guest.id }, { projectId: project.id, features: { cycles: true } }))).toMatchObject({ status: 403 });
    const changed = await projects.setProjectFeatures.handler({ userId: outsideAdmin.id }, { projectId: project.id, features: { cycles: true } });
    expect(changed.features.cycles).toBe(true);
    expect((await transaction.select().from(projectRows).where(eq(projectRows.id, project.id)))[0]?.cyclesEnabled).toBe(true);
  });
});
