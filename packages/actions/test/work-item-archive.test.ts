import { afterAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { activities, createDatabase, type Database } from "@weft/db";
import {
  createActionList, createChatStore, createCommentActions, createConfirmationStore, createCycleActions, createIntakeActions, createModuleActions, createProjectActions,
  createRelationActions, createSearchActions, createWebLinkActions, createWikiActions, createWorkItemActions, createWorkItemArchiveActions,
} from "../src";
import { createMemberFactory, createWorkspaceFactory, withRollback } from "../../db/src/test-helpers";

const { client, db } = createDatabase();
afterAll(async () => client.end());

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

async function setup(transaction: Database) {
  const workspace = await createWorkspaceFactory(transaction);
  const admin = await createMemberFactory(transaction, workspace.id, "Admin");
  const member = await createMemberFactory(transaction, workspace.id, "Member");
  const guest = await createMemberFactory(transaction, workspace.id, "Guest");
  const outsider = await createMemberFactory(transaction, workspace.id, "Member");
  const projects = createProjectActions(transaction);
  const project = await projects.createProject.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Mobile", key: "MOB", visibility: "private" });
  await projects.addProjectMember.handler({ userId: admin.id }, { projectId: project.id, userId: member.id, role: "Member" });
  await projects.addProjectMember.handler({ userId: admin.id }, { projectId: project.id, userId: guest.id, role: "Guest" });
  const work = createWorkItemActions(transaction);
  const archive = createWorkItemArchiveActions(transaction);
  const states = await work.listStates.handler({ userId: member.id }, { projectId: project.id });
  const stateOf = (group: string) => states.find((state) => state.group === group)!.id;
  /** A work item in the given state group (Done unless said otherwise). */
  const item = (title = "Item", group = "completed") => work.createWorkItem.handler({ userId: member.id }, { projectId: project.id, title, stateId: stateOf(group) });
  const as = { userId: member.id };
  const reason = (promise: Promise<unknown>) => promise.then(() => "ok", (error: Error & { status?: number }) => `${error.status} ${error.message}`);
  return { workspace, admin, member, guest, outsider, project, work, archive, item, as, stateOf, reason, transaction };
}

test.concurrent("a Member archives a completed item, a cancelled one too, and an Admin restores it", async () => {
  await withRollback(db, async (transaction) => {
    const { archive, item, as, admin, work, project } = await setup(transaction);
    const done = await item("Done one"), cancelled = await item("Cancelled one", "cancelled");
    const archived = await archive.archiveWorkItem.handler(as, { workItemId: done.id });
    expect(archived.archivedAt).not.toBeNull();
    expect((await archive.archiveWorkItem.handler(as, { workItemId: cancelled.id })).archivedAt).not.toBeNull();
    expect((await work.listWorkItems.handler(as, { projectId: project.id })).map((row) => row.id)).toEqual([]);
    expect(await archive.restoreWorkItem.handler({ userId: admin.id }, { workItemId: done.id })).toEqual({ id: done.id, archivedAt: null });
    expect((await work.listWorkItems.handler(as, { projectId: project.id })).map((row) => row.id)).toEqual([done.id]);
  });
});

test.concurrent("archive refuses a state group other than completed or cancelled, and a Triage item, each naming the reason", async () => {
  await withRollback(db, async (transaction) => {
    const { archive, item, as, member, project, reason } = await setup(transaction);
    for (const group of ["backlog", "unstarted", "started"]) {
      expect(await reason(archive.archiveWorkItem.handler(as, { workItemId: (await item(group, group)).id }))).toBe("400 Only a completed or cancelled work item can be archived");
    }
    const intake = createIntakeActions(transaction);
    const submitted = await intake.submitIntakeItem.handler({ userId: member.id }, { projectId: project.id, title: "Undecided" });
    expect(await reason(archive.archiveWorkItem.handler(as, { workItemId: submitted.workItemId }))).toBe("400 A work item in Triage cannot be archived");
  });
});

test.concurrent("archive refuses an item in a Cycle that has not completed, and allows one in a completed Cycle", async () => {
  await withRollback(db, async (transaction) => {
    const { archive, item, as, project, reason } = await setup(transaction);
    const cycles = createCycleActions(transaction);
    const open = await cycles.createCycle.handler(as, { projectId: project.id, name: "Now", startDate: day(-1), endDate: day(6) });
    const over = await cycles.createCycle.handler(as, { projectId: project.id, name: "Then", startDate: day(-20), endDate: day(-10) });
    const a = await item("A"), b = await item("B");
    await cycles.addCycleItems.handler(as, { cycleId: open.id, workItemIds: [a.id] });
    await transaction.execute(`insert into cycle_items (work_item_id, cycle_id, workspace_id, project_id) select '${b.id}', '${over.id}', workspace_id, id from projects where id = '${project.id}'` as never);
    expect(await reason(archive.archiveWorkItem.handler(as, { workItemId: a.id }))).toBe("400 A work item in a Cycle that has not completed cannot be archived");
    expect((await archive.archiveWorkItem.handler(as, { workItemId: b.id })).archivedAt).not.toBeNull();
  });
});

test.concurrent("archive refuses an item in a Module that is not completed or cancelled", async () => {
  await withRollback(db, async (transaction) => {
    const { archive, item, as, project, reason } = await setup(transaction);
    const modules = createModuleActions(transaction);
    const module = await modules.createModule.handler(as, { projectId: project.id, name: "Auth" });
    const one = await item("One");
    await modules.addModuleItems.handler(as, { moduleId: module.id, workItemIds: [one.id] });
    expect(await reason(archive.archiveWorkItem.handler(as, { workItemId: one.id }))).toBe("400 A work item in a Module that is not completed or cancelled cannot be archived");
    await modules.updateModule.handler(as, { moduleId: module.id, status: "cancelled" });
    expect((await archive.archiveWorkItem.handler(as, { workItemId: one.id })).archivedAt).not.toBeNull();
  });
});

test.concurrent("archive is idempotent and keeps the first time; restore clears it and changes nothing else; Activity records both", async () => {
  await withRollback(db, async (transaction) => {
    const { archive, item, as, work, reason } = await setup(transaction);
    const one = await item("One");
    const first = await archive.archiveWorkItem.handler(as, { workItemId: one.id });
    await Bun.sleep(5);
    expect(await archive.archiveWorkItem.handler(as, { workItemId: one.id })).toEqual(first);
    const before = await work.getWorkItem.handler(as, { workspaceId: (await transaction.query.workspaces.findFirst())!.id, displayId: one.displayId });
    expect(before.archivedAt).toBe(first.archivedAt);
    await archive.restoreWorkItem.handler({ ...as, source: "cli" }, { workItemId: one.id });
    const after = await work.getWorkItem.handler(as, { workspaceId: (await transaction.query.workspaces.findFirst())!.id, displayId: one.displayId });
    expect(after).toEqual({ ...before, archivedAt: null });
    expect(await archive.restoreWorkItem.handler(as, { workItemId: one.id })).toEqual({ id: one.id, archivedAt: null });
    const log = await work.listWorkItemActivities.handler(as, { workItemId: one.id });
    expect(log.filter((row) => row.field === "archived" || row.field === "restored").map((row) => [row.field, row.source])).toEqual([["archived", "ui"], ["restored", "cli"]]);
    expect(await reason(archive.archiveWorkItem.handler(as, { workItemId: crypto.randomUUID() }))).toBe("404 Work item not found");
  });
});

test.concurrent("only project Admin and Member archive and restore; Guest and non-members are refused", async () => {
  await withRollback(db, async (transaction) => {
    const { archive, item, as, admin, guest, outsider, reason } = await setup(transaction);
    const one = await item("One");
    expect(await reason(archive.archiveWorkItem.handler({ userId: guest.id }, { workItemId: one.id }))).toStartWith("403");
    expect(await reason(archive.archiveWorkItem.handler({ userId: outsider.id }, { workItemId: one.id }))).toStartWith("40");
    expect((await archive.archiveWorkItem.handler({ userId: admin.id }, { workItemId: one.id })).archivedAt).not.toBeNull();
    expect(await reason(archive.restoreWorkItem.handler({ userId: guest.id }, { workItemId: one.id }))).toStartWith("403");
    expect(await reason(archive.restoreWorkItem.handler({ userId: outsider.id }, { workItemId: one.id }))).toStartWith("40");
    expect((await archive.restoreWorkItem.handler(as, { workItemId: one.id })).archivedAt).toBeNull();
  });
});

test.concurrent("archived items are hidden from lists, search, PQL, Cycle and Module contents and counts; archived: true lists only them", async () => {
  await withRollback(db, async (transaction) => {
    const { archive, item, as, work, project, workspace, stateOf } = await setup(transaction);
    const cycles = createCycleActions(transaction), modules = createModuleActions(transaction), search = createSearchActions(transaction);
    const cycle = await cycles.createCycle.handler(as, { projectId: project.id, name: "Then", startDate: day(-20), endDate: day(-10) });
    const module = await modules.createModule.handler(as, { projectId: project.id, name: "Auth", status: "completed" });
    const keep = await item("Needle kept"), gone = await item("Needle gone");
    await cycles.addCycleItems.handler(as, { cycleId: cycle.id, workItemIds: [keep.id, gone.id] }).catch(() => undefined);
    await transaction.execute(`insert into cycle_items (work_item_id, cycle_id, workspace_id, project_id) select w.id, '${cycle.id}', w.workspace_id, w.project_id from work_items w where w.project_id = '${project.id}' on conflict do nothing` as never);
    await modules.addModuleItems.handler(as, { moduleId: module.id, workItemIds: [keep.id, gone.id] });
    await archive.archiveWorkItem.handler(as, { workItemId: gone.id });
    const ids = (rows: Array<{ id: string }>) => rows.map((row) => row.id);
    expect(ids(await work.listWorkItems.handler(as, { projectId: project.id }))).toEqual([keep.id]);
    expect(ids(await work.listWorkItems.handler(as, { projectId: project.id, query: "title ~ Needle" }))).toEqual([keep.id]);
    expect(ids(await work.listWorkItems.handler(as, { projectId: project.id, cycleId: cycle.id }))).toEqual([keep.id]);
    expect(ids(await work.listWorkItems.handler(as, { projectId: project.id, moduleId: module.id }))).toEqual([keep.id]);
    expect(ids(await work.listWorkspaceWorkItems.handler(as, { workspaceId: workspace.id }))).toEqual([keep.id]);
    expect(ids(await search.searchWorkItems.handler(as, { workspaceId: workspace.id, query: "Needle" }))).toEqual([keep.id]);
    expect(ids(await search.searchWorkItems.handler(as, { workspaceId: workspace.id, projectId: project.id, pql: "title ~ Needle" } as never))).toEqual([keep.id]);
    expect((await cycles.getCycle.handler(as, { cycleId: cycle.id })).workItemIds).toEqual([keep.id]);
    expect((await cycles.listCycles.handler(as, { projectId: project.id }))[0]).toMatchObject({ itemCount: 1, progress: { total: 1, completed: 1 } });
    expect(await modules.getModule.handler(as, { moduleId: module.id })).toMatchObject({ itemCount: 1, workItemIds: [keep.id] });
    expect(ids(await work.listWorkItems.handler(as, { projectId: project.id, archived: true }))).toEqual([gone.id]);
    expect(stateOf("completed")).toBeTruthy();
  });
});

test.concurrent("archiving a parent leaves its sub-items unchanged and listed", async () => {
  await withRollback(db, async (transaction) => {
    const { archive, item, as, work, project, stateOf } = await setup(transaction);
    const parent = await item("Parent");
    const child = await work.createWorkItem.handler(as, { projectId: project.id, title: "Child", parentId: parent.id, stateId: stateOf("started") });
    await archive.archiveWorkItem.handler(as, { workItemId: parent.id });
    expect((await work.listSubWorkItems.handler(as, { workItemId: parent.id })).map((row) => row.id)).toEqual([child.id]);
    expect((await work.listWorkItems.handler(as, { projectId: project.id })).map((row) => row.id)).toEqual([child.id]);
    expect((await work.listWorkItems.handler(as, { projectId: project.id })).find((row) => row.id === child.id)).toMatchObject({ archivedAt: null, parentId: parent.id });
  });
});

test.concurrent("every other write on an archived item is refused with \"Work item is archived\", reads still work", async () => {
  await withRollback(db, async (transaction) => {
    const { archive, item, as, work, project, workspace, stateOf, reason, member } = await setup(transaction);
    const comments = createCommentActions(transaction), relations = createRelationActions(transaction), links = createWebLinkActions(transaction), cycles = createCycleActions(transaction), modules = createModuleActions(transaction);
    const one = await item("One"), other = await item("Other");
    const comment = await comments.createComment.handler(as, { workItemId: one.id, body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }] } });
    const link = await links.createWebLink.handler(as, { workItemId: one.id, url: "https://example.com" });
    await relations.createWorkItemRelation.handler(as, { workItemId: one.id, relatedWorkItemId: other.id, type: "relates_to" });
    const cycle = await cycles.createCycle.handler(as, { projectId: project.id, name: "Later", startDate: day(5), endDate: day(9) });
    const module = await modules.createModule.handler(as, { projectId: project.id, name: "Auth", status: "completed" });
    const spare = await item("Spare");
    const wiki = createWikiActions(transaction);
    const page = await wiki.createWikiPage.handler(as, { workspaceId: workspace.id, projectId: project.id, title: "Notes" });
    await wiki.linkWorkItemPage.handler(as, { workItemId: one.id, pageId: page.id });
    await archive.archiveWorkItem.handler(as, { workItemId: one.id });
    const refused = "400 Work item is archived";
    const body = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "again" }] }] };
    const writes: Array<[string, () => Promise<unknown>]> = [
      ["update fields", () => work.updateWorkItem.handler(as, { workItemId: one.id, title: "New" })],
      ["update state", () => work.updateWorkItem.handler(as, { workItemId: one.id, stateId: stateOf("started") })],
      ["move", () => work.moveWorkItem.handler(as, { workItemId: one.id, stateId: stateOf("cancelled") })],
      ["delete", () => work.deleteWorkItem.handler(as, { workItemId: one.id })],
      ["restore a description version", () => work.restoreWorkItemDescriptionVersion.handler(as, { workItemId: one.id, versionId: crypto.randomUUID() })],
      ["comment", () => comments.createComment.handler(as, { workItemId: one.id, body })],
      ["edit comment", () => comments.updateComment.handler(as, { commentId: comment.id, body })],
      ["delete comment", () => comments.deleteComment.handler(as, { commentId: comment.id })],
      ["create link", () => links.createWebLink.handler(as, { workItemId: one.id, url: "https://example.org" })],
      ["update link", () => links.updateWebLink.handler(as, { webLinkId: link.id, title: "x" })],
      ["delete link", () => links.deleteWebLink.handler(as, { webLinkId: link.id })],
      ["relate", () => relations.createWorkItemRelation.handler(as, { workItemId: spare.id, relatedWorkItemId: one.id, type: "duplicate" })],
      ["unrelate", () => relations.removeWorkItemRelation.handler(as, { workItemId: one.id, relatedWorkItemId: other.id })],
      ["add a sub-item", () => work.createWorkItem.handler(as, { projectId: project.id, title: "Child", parentId: one.id })],
      ["make a sub-item", () => work.updateWorkItem.handler(as, { workItemId: spare.id, parentId: one.id })],
      ["add to a Cycle", () => cycles.addCycleItems.handler(as, { cycleId: cycle.id, workItemIds: [one.id] })],
      ["remove from a Cycle", () => cycles.removeCycleItems.handler(as, { cycleId: cycle.id, workItemIds: [one.id] })],
      ["add to a Module", () => modules.addModuleItems.handler(as, { moduleId: module.id, workItemIds: [one.id] })],
      ["link a page", () => wiki.linkWorkItemPage.handler(as, { workItemId: one.id, pageId: page.id })],
      ["unlink a page", () => wiki.unlinkWorkItemPage.handler(as, { workItemId: one.id, pageId: page.id })],
      ["remove from a Module", () => modules.removeModuleItems.handler(as, { moduleId: module.id, workItemIds: [one.id] })],
    ];
    for (const [name, write] of writes) expect([name, await reason(write())]).toEqual([name, refused]);
    // Reads still work.
    expect((await work.getWorkItem.handler(as, { workspaceId: workspace.id, displayId: one.displayId })).archivedAt).not.toBeNull();
    expect(await comments.listComments.handler(as, { workItemId: one.id })).toHaveLength(1);
    expect(await relations.listWorkItemRelations.handler(as, { workItemId: one.id })).toHaveLength(1);
    expect(await links.listWebLinks.handler(as, { workItemId: one.id })).toHaveLength(1);
    expect((await work.listWorkItemActivities.handler(as, { workItemId: one.id })).length).toBeGreaterThan(0);
    // Restore is the only write: after it, the same edit works.
    await archive.restoreWorkItem.handler(as, { workItemId: one.id });
    expect((await work.updateWorkItem.handler({ userId: member.id }, { workItemId: one.id, title: "New" })).title).toBe("New");
    const rows = await transaction.select().from(activities).where(and(eq(activities.entityId, one.id), eq(activities.field, "title")));
    expect(rows).toHaveLength(1);
  });
});

test.concurrent("archive and restore are Write actions: in the registry, proposed as Confirmations for the AI, and run only on confirm", async () => {
  await withRollback(db, async (transaction) => {
    const { archive, item, as, workspace, member, work } = await setup(transaction);
    const names = createActionList(transaction).map((action) => action.name);
    expect(names).toContain("archive_work_item");
    expect(names).toContain("restore_work_item");
    expect(createActionList(transaction).filter((action) => ["archive_work_item", "restore_work_item"].includes(action.name)).map((action) => action.kind)).toEqual(["write", "write"]);
    const chat = (await createChatStore(transaction).upsertChat({ id: crypto.randomUUID(), workspaceId: workspace.id, userId: member.id, title: "chat" }))!;
    const store = createConfirmationStore(transaction);
    const one = await item("One");
    const card = await store.propose({ userId: member.id, workspaceId: workspace.id, chatId: chat.id, action: "archive_work_item", input: { workItemId: one.id } });
    expect((await work.listWorkItems.handler(as, { projectId: one.projectId, archived: true }))).toHaveLength(0);
    expect((await store.confirm(member.id, card.id)).status).toBe("confirmed");
    expect((await work.listWorkItems.handler(as, { projectId: one.projectId, archived: true })).map((row) => row.id)).toEqual([one.id]);
    const back = await store.propose({ userId: member.id, workspaceId: workspace.id, chatId: chat.id, action: "restore_work_item", input: { workItemId: one.id } });
    expect((await store.confirm(member.id, back.id)).status).toBe("confirmed");
    expect((await archive.restoreWorkItem.handler(as, { workItemId: one.id })).archivedAt).toBeNull();
  });
});
