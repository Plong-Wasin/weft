import { afterAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { activities, createDatabase, workItemRelations, type Database } from "@weft/db";
import { createProjectActions, createRelationActions, createWorkItemActions } from "../src";
import { createMemberFactory, createWorkspaceFactory, withRollback } from "../../db/src/test-helpers";

const { client, db } = createDatabase();
afterAll(async () => client.end());

async function setup(transaction: Database, visibility: "public" | "private" = "public") {
  const workspace = await createWorkspaceFactory(transaction);
  const admin = await createMemberFactory(transaction, workspace.id, "Admin");
  const member = await createMemberFactory(transaction, workspace.id, "Member");
  const guest = await createMemberFactory(transaction, workspace.id, "Guest");
  const bystander = await createMemberFactory(transaction, workspace.id, "Member");
  const projects = createProjectActions(transaction);
  const project = await projects.createProject.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Mobile", key: "MOB", visibility });
  const other = await projects.createProject.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Web", key: "WEB", visibility });
  for (const user of [member, guest]) await projects.addProjectMember.handler({ userId: admin.id }, { projectId: project.id, userId: user.id, role: user === guest ? "Guest" : "Member" });
  const items = createWorkItemActions(transaction);
  const a = await items.createWorkItem.handler({ userId: member.id }, { projectId: project.id, title: "A" });
  const b = await items.createWorkItem.handler({ userId: member.id }, { projectId: project.id, title: "B" });
  const c = await items.createWorkItem.handler({ userId: member.id }, { projectId: project.id, title: "C" });
  const foreign = await items.createWorkItem.handler({ userId: admin.id }, { projectId: other.id, title: "Foreign" });
  return { admin, member, guest, bystander, items, a, b, c, foreign, relations: createRelationActions(transaction) };
}

test.concurrent("blocks and blocked_by are one stored row with inverse views", async () => {
  await withRollback(db, async (transaction) => {
    const { relations, member, a, b } = await setup(transaction);
    await relations.createWorkItemRelation.handler({ userId: member.id }, { workItemId: a.id, relatedWorkItemId: b.id, type: "blocks" });
    expect(await transaction.select().from(workItemRelations)).toHaveLength(1);
    const fromA = await relations.listWorkItemRelations.handler({ userId: member.id }, { workItemId: a.id });
    const fromB = await relations.listWorkItemRelations.handler({ userId: member.id }, { workItemId: b.id });
    expect(fromA).toMatchObject([{ type: "blocks", workItem: { id: b.id, displayId: b.displayId, title: "B" } }]);
    expect(fromB).toMatchObject([{ type: "blocked_by", workItem: { id: a.id } }]);
  });
});

test.concurrent("duplicate and relates_to are symmetric", async () => {
  await withRollback(db, async (transaction) => {
    const { relations, member, a, b, c } = await setup(transaction);
    await relations.createWorkItemRelation.handler({ userId: member.id }, { workItemId: a.id, relatedWorkItemId: b.id, type: "duplicate" });
    await relations.createWorkItemRelation.handler({ userId: member.id }, { workItemId: c.id, relatedWorkItemId: a.id, type: "relates_to" });
    const fromA = await relations.listWorkItemRelations.handler({ userId: member.id }, { workItemId: a.id });
    expect(fromA.map((row) => [row.type, row.workItem.id]).sort()).toEqual([["duplicate", b.id], ["relates_to", c.id]].sort());
    expect((await relations.listWorkItemRelations.handler({ userId: member.id }, { workItemId: b.id }))[0]).toMatchObject({ type: "duplicate", workItem: { id: a.id } });
  });
});

test.concurrent("self, cross-project, deleted, and already-linked pairs are refused", async () => {
  await withRollback(db, async (transaction) => {
    const { relations, items, member, admin, a, b, foreign } = await setup(transaction);
    const create = (workItemId: string, relatedWorkItemId: string, type: "blocks" | "blocked_by" | "duplicate" | "relates_to" = "relates_to") => relations.createWorkItemRelation.handler({ userId: member.id }, { workItemId, relatedWorkItemId, type });
    await expect(create(a.id, a.id)).rejects.toMatchObject({ status: 400 });
    await expect(create(a.id, foreign.id)).rejects.toMatchObject({ status: 400 });
    await create(a.id, b.id, "blocks");
    await expect(create(a.id, b.id, "blocks")).rejects.toMatchObject({ status: 400 });
    await expect(create(b.id, a.id, "duplicate")).rejects.toMatchObject({ status: 400 });
    const gone = await items.createWorkItem.handler({ userId: admin.id }, { projectId: a.projectId, title: "Gone" });
    await items.deleteWorkItem.handler({ userId: admin.id }, { workItemId: gone.id });
    await expect(create(a.id, gone.id)).rejects.toMatchObject({ status: 404 });
    await expect(create(a.id, crypto.randomUUID())).rejects.toMatchObject({ status: 404 });
  });
});

test.concurrent("deleting a work item hides its relations", async () => {
  await withRollback(db, async (transaction) => {
    const { relations, items, member, a, b } = await setup(transaction);
    await relations.createWorkItemRelation.handler({ userId: member.id }, { workItemId: a.id, relatedWorkItemId: b.id, type: "blocks" });
    await items.deleteWorkItem.handler({ userId: member.id }, { workItemId: b.id });
    expect(await relations.listWorkItemRelations.handler({ userId: member.id }, { workItemId: a.id })).toEqual([]);
  });
});

test.concurrent("create and remove write Activity on both work items, with the view from each side", async () => {
  await withRollback(db, async (transaction) => {
    const { relations, member, a, b } = await setup(transaction);
    await relations.createWorkItemRelation.handler({ userId: member.id, source: "mcp" }, { workItemId: a.id, relatedWorkItemId: b.id, type: "blocks" });
    await relations.removeWorkItemRelation.handler({ userId: member.id }, { workItemId: b.id, relatedWorkItemId: a.id });
    expect(await relations.listWorkItemRelations.handler({ userId: member.id }, { workItemId: a.id })).toEqual([]);
    const log = async (id: string) => (await transaction.select().from(activities).where(and(eq(activities.entityId, id), eq(activities.entityType, "work_item")))).filter((row) => row.field.startsWith("relation_")).sort((x, y) => x.seq - y.seq);
    const onA = await log(a.id);
    const onB = await log(b.id);
    expect(onA.map((row) => [row.field, row.newValue ?? row.oldValue, row.source])).toEqual([
      ["relation_added", { type: "blocks", workItemId: b.id }, "mcp"], ["relation_removed", { type: "blocks", workItemId: b.id }, "ui"],
    ]);
    expect(onB.map((row) => [row.field, row.newValue ?? row.oldValue])).toEqual([
      ["relation_added", { type: "blocked_by", workItemId: a.id }], ["relation_removed", { type: "blocked_by", workItemId: a.id }],
    ]);
  });
});

test.concurrent("remove of a missing relation is 404", async () => {
  await withRollback(db, async (transaction) => {
    const { relations, member, a, b } = await setup(transaction);
    await expect(relations.removeWorkItemRelation.handler({ userId: member.id }, { workItemId: a.id, relatedWorkItemId: b.id })).rejects.toMatchObject({ status: 404 });
  });
});

test.concurrent("guest reads but cannot write; outsiders of a private project see nothing", async () => {
  await withRollback(db, async (transaction) => {
    const { relations, member, guest, a, b } = await setup(transaction);
    await relations.createWorkItemRelation.handler({ userId: member.id }, { workItemId: a.id, relatedWorkItemId: b.id, type: "relates_to" });
    expect(await relations.listWorkItemRelations.handler({ userId: guest.id }, { workItemId: a.id })).toHaveLength(1);
    await expect(relations.createWorkItemRelation.handler({ userId: guest.id }, { workItemId: a.id, relatedWorkItemId: b.id, type: "duplicate" })).rejects.toMatchObject({ status: 403 });
    await expect(relations.removeWorkItemRelation.handler({ userId: guest.id }, { workItemId: a.id, relatedWorkItemId: b.id })).rejects.toMatchObject({ status: 403 });
    const priv = await setup(transaction, "private");
    await priv.relations.createWorkItemRelation.handler({ userId: priv.member.id }, { workItemId: priv.a.id, relatedWorkItemId: priv.b.id, type: "relates_to" });
    await expect(priv.relations.listWorkItemRelations.handler({ userId: priv.bystander.id }, { workItemId: priv.a.id })).rejects.toMatchObject({ status: 404 });
    await expect(priv.relations.createWorkItemRelation.handler({ userId: priv.bystander.id }, { workItemId: priv.a.id, relatedWorkItemId: priv.c.id, type: "relates_to" })).rejects.toMatchObject({ status: 404 });
  });
});
