import { afterAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createDatabase, workItems, workspaceMembers, type Database } from "@weft/db";
import { createCycleActions, createModuleActions, createProjectActions, createTargetActions, createWikiActions, createWorkItemActions } from "../src";
import { createMemberFactory, createUserFactory, createWorkspaceFactory, withRollback } from "../../db/src/test-helpers";

const { client, db } = createDatabase();
afterAll(async () => client.end());

async function fixture(transaction: Database) {
  const workspace = await createWorkspaceFactory(transaction);
  const admin = await createMemberFactory(transaction, workspace.id, "Admin");
  const outsider = await createMemberFactory(transaction, workspace.id, "Member");
  const project = await createProjectActions(transaction).createProject.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Secret", key: "SEC", visibility: "private" });
  const work = createWorkItemActions(transaction);
  const item = await work.createWorkItem.handler({ userId: admin.id }, { projectId: project.id, title: "Hidden title" });
  const cycle = await createCycleActions(transaction).createCycle.handler({ userId: admin.id }, { projectId: project.id, name: "Hidden cycle", startDate: "2030-01-01", endDate: "2030-01-14" });
  const module = await createModuleActions(transaction).createModule.handler({ userId: admin.id }, { projectId: project.id, name: "Hidden module" });
  const page = await createWikiActions(transaction).createWikiPage.handler({ userId: admin.id }, { workspaceId: workspace.id, title: "Hidden page", access: "private" });
  const targets = createTargetActions(transaction);
  const resolve = (userId: string, input: { refs?: Array<{ kind: "work_item" | "wiki_page" | "cycle" | "module" | "project"; id: string }>; displayIds?: string[] }) =>
    targets.resolveTargets.handler({ userId }, { workspaceId: workspace.id, ...input });
  const refs = [
    { kind: "work_item" as const, id: item.id }, { kind: "cycle" as const, id: cycle.id }, { kind: "module" as const, id: module.id },
    { kind: "wiki_page" as const, id: page.id }, { kind: "project" as const, id: project.id },
  ];
  return { workspace, admin, outsider, project, item, cycle, module, page, work, resolve, refs };
}

test.concurrent("resolves every kind a viewer may see, with the title, project key and state", async () => {
  await withRollback(db, async (transaction) => {
    const { admin, resolve, refs, item, project } = await fixture(transaction);
    const found = await resolve(admin.id, { refs });
    expect(found.map((target) => [target.kind, target.title, target.status])).toEqual([
      ["work_item", "Hidden title", "available"], ["cycle", "Hidden cycle", "available"], ["module", "Hidden module", "available"],
      ["wiki_page", "Hidden page", "available"], ["project", "Secret", "available"],
    ]);
    expect(found[0]).toMatchObject({ ref: item.id, id: item.id, displayId: "SEC-1", projectKey: "SEC", stateGroup: "backlog" });
    expect(found[1]).toMatchObject({ projectKey: "SEC", id: expect.any(String) });
    expect(found[4]).toMatchObject({ id: project.id, projectKey: "SEC" });
  });
});

test.concurrent("a viewer without access gets nothing: no title by id or by display id", async () => {
  await withRollback(db, async (transaction) => {
    const { outsider, resolve, refs } = await fixture(transaction);
    const found = await resolve(outsider.id, { refs, displayIds: ["SEC-1"] });
    expect(found).toEqual([]);
    expect(JSON.stringify(found)).not.toContain("Hidden");
  });
});

test.concurrent("a user outside the workspace is refused", async () => {
  await withRollback(db, async (transaction) => {
    const { resolve, refs } = await fixture(transaction);
    const stranger = await createUserFactory(transaction);
    await expect(resolve(stranger.id, { refs })).rejects.toThrow();
  });
});

test.concurrent("resolves display ids written in text, case-insensitively and through an old project key", async () => {
  await withRollback(db, async (transaction) => {
    const { admin, resolve, project, item } = await fixture(transaction);
    await createProjectActions(transaction).renameProjectKey.handler({ userId: admin.id }, { projectId: project.id, key: "NEW" });
    const found = await resolve(admin.id, { displayIds: ["sec-1", "NEW-1", "NEW-99", "ZZZ-1"] });
    expect(found.map((target) => [target.ref, target.id, target.displayId])).toEqual([["sec-1", item.id, "NEW-1"], ["NEW-1", item.id, "NEW-1"]]);
  });
});

test.concurrent("deleted and archived targets are returned as such, only to those who may see them", async () => {
  await withRollback(db, async (transaction) => {
    const { admin, outsider, resolve, work, item, project, page, cycle } = await fixture(transaction);
    const archived = await work.createWorkItem.handler({ userId: admin.id }, { projectId: project.id, title: "Old" });
    await transaction.update(workItems).set({ archivedAt: new Date() }).where(eq(workItems.id, archived.id));
    await work.deleteWorkItem.handler({ userId: admin.id }, { workItemId: item.id });
    await createWikiActions(transaction).deleteWikiPage.handler({ userId: admin.id }, { pageId: page.id });
    await createCycleActions(transaction).deleteCycle.handler({ userId: admin.id }, { cycleId: cycle.id });
    const refs = [
      { kind: "work_item" as const, id: item.id }, { kind: "work_item" as const, id: archived.id },
      { kind: "wiki_page" as const, id: page.id }, { kind: "cycle" as const, id: cycle.id },
    ];
    expect((await resolve(admin.id, { refs })).map((target) => target.status)).toEqual(["deleted", "archived", "deleted", "deleted"]);
    expect(await resolve(outsider.id, { refs })).toEqual([]);
  });
});

test.concurrent("a private Collection stays closed to a Guest and a Member after its page and itself are deleted", async () => {
  await withRollback(db, async (transaction) => {
    const { workspace, admin, outsider, resolve } = await fixture(transaction);
    const guest = await createMemberFactory(transaction, workspace.id, "Guest");
    const wiki = createWikiActions(transaction);
    const collection = await wiki.createCollection.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Mine", visibility: "private" });
    const page = await wiki.createWikiPage.handler({ userId: admin.id }, { workspaceId: workspace.id, title: "Collection secret", collectionId: collection.id });
    const refs = [{ kind: "wiki_page" as const, id: page.id }];
    const expectClosed = async () => {
      expect(await resolve(guest.id, { refs })).toEqual([]);
      expect(await resolve(outsider.id, { refs })).toEqual([]);
    };
    await expectClosed();
    await wiki.deleteWikiPage.handler({ userId: admin.id }, { pageId: page.id });
    await expectClosed();
    await wiki.deleteCollection.handler({ userId: admin.id }, { collectionId: collection.id });
    await expectClosed();
    expect((await resolve(admin.id, { refs })).map((target) => [target.title, target.status])).toEqual([["Collection secret", "deleted"]]);
  });
});

test.concurrent("a workspace Guest outside a private project gets nothing from it", async () => {
  await withRollback(db, async (transaction) => {
    const { workspace, resolve, refs } = await fixture(transaction);
    const guest = await createMemberFactory(transaction, workspace.id, "Guest");
    expect(await resolve(guest.id, { refs, displayIds: ["SEC-1"] })).toEqual([]);
  });
});

test.concurrent("refs from another workspace the caller belongs to are left out", async () => {
  await withRollback(db, async (transaction) => {
    const { admin, refs } = await fixture(transaction);
    const other = await createWorkspaceFactory(transaction);
    await transaction.insert(workspaceMembers).values({ workspaceId: other.id, userId: admin.id, role: "Admin" });
    const found = await createTargetActions(transaction).resolveTargets.handler({ userId: admin.id }, { workspaceId: other.id, refs, displayIds: ["SEC-1"] });
    expect(found).toEqual([]);
  });
});
