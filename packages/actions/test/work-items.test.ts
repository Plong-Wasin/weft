import { afterAll, expect, test } from "bun:test";
import { and, asc, eq, sql } from "drizzle-orm";
import { activities, createDatabase, users, workspaces, type Database } from "@weft/db";
import { createProjectActions, createWorkItemActions, descriptionVersionIntervalMs } from "../src";
import { createMemberFactory, createWorkspaceFactory, withRollback } from "../../db/src/test-helpers";

const { client, db } = createDatabase();
afterAll(async () => client.end());

async function setup(transaction: Database) {
  const workspace = await createWorkspaceFactory(transaction);
  const admin = await createMemberFactory(transaction, workspace.id, "Admin");
  const member = await createMemberFactory(transaction, workspace.id, "Member");
  const guest = await createMemberFactory(transaction, workspace.id, "Guest");
  const projects = createProjectActions(transaction);
  const items = createWorkItemActions(transaction);
  const project = await projects.createProject.handler({ userId: member.id }, { workspaceId: workspace.id, name: "Mobile", key: "MOB", visibility: "public" });
  const create = (input: Partial<{ title: string; priority: "urgent" | "high" | "medium" | "low" | "none" }> = {}, userId = member.id) =>
    items.createWorkItem.handler({ userId }, { projectId: project.id, title: input.title ?? "Fix login", ...input });
  return { workspace, admin, member, guest, projects, items, project, create };
}

test.concurrent("a new project starts with default states in every group", async () => {
  await withRollback(db, async (transaction) => {
    const { items, member, project } = await setup(transaction);
    const states = await items.listStates.handler({ userId: member.id }, { projectId: project.id });
    expect([...new Set(states.map((state) => state.group))]).toEqual(["backlog", "unstarted", "started", "completed", "cancelled"]);
  });
});

test.concurrent("a member creates a work item with an ID, default state and priority, and reads it back by display ID", async () => {
  await withRollback(db, async (transaction) => {
    const { items, member, workspace, create } = await setup(transaction);
    const first = await create({ title: "Fix login", priority: "high" });
    const second = await create({ title: "Second" });
    expect(first.displayId).toBe("MOB-1");
    expect(second.displayId).toBe("MOB-2");
    expect(first.priority).toBe("high");
    expect(second.priority).toBe("none");
    const states = await items.listStates.handler({ userId: member.id }, { projectId: first.projectId });
    expect(first.stateId).toBe(states[0]!.id);
    const found = await items.getWorkItem.handler({ userId: member.id }, { workspaceId: workspace.id, displayId: "mob-2" });
    expect(found.id).toBe(second.id);
    const list = await items.listWorkItems.handler({ userId: member.id }, { projectId: first.projectId });
    expect(list.map((item) => item.displayId)).toEqual(["MOB-1", "MOB-2"]);
  });
});

test.concurrent("work item descriptions accept and return Markdown while preserving editor documents", async () => {
  await withRollback(db, async (transaction) => {
    const { items, member, project } = await setup(transaction);
    const item = await items.createWorkItem.handler({ userId: member.id }, { projectId: project.id, title: "Markdown", descriptionMarkdown: "## Plan\n\n- one" });
    expect(item.descriptionMarkdown).toContain("## Plan");
    const updated = await items.updateWorkItem.handler({ userId: member.id }, { workItemId: item.id, descriptionMarkdown: "**done**" });
    expect(updated.descriptionMarkdown).toBe("**done**");
    await expect(items.updateWorkItem.handler({ userId: member.id }, { workItemId: item.id, description: { type: "doc", content: [] }, descriptionMarkdown: "md" } as never)).rejects.toThrow("Send either descriptionMarkdown");
  });
});

test.concurrent("display ID resolves through an old project key alias and shows the current key", async () => {
  await withRollback(db, async (transaction) => {
    const { items, projects, member, workspace, project, create } = await setup(transaction);
    const item = await create();
    await projects.renameProjectKey.handler({ userId: member.id }, { projectId: project.id, key: "APP" });
    const found = await items.getWorkItem.handler({ userId: member.id }, { workspaceId: workspace.id, displayId: "MOB-1" });
    expect(found.id).toBe(item.id);
    expect(found.displayId).toBe("APP-1");
    await expect(items.getWorkItem.handler({ userId: member.id }, { workspaceId: workspace.id, displayId: "MOB-99" })).rejects.toMatchObject({ status: 404 });
  });
});

test("sequence numbers have no gaps or duplicates under concurrent creation", async () => {
  const workspace = await createWorkspaceFactory(db);
  let memberId: string | undefined;
  try {
    const member = await createMemberFactory(db, workspace.id, "Member");
    memberId = member.id;
    const project = await createProjectActions(db).createProject.handler({ userId: member.id }, { workspaceId: workspace.id, name: "Race", key: "RACE", visibility: "public" });
    const items = createWorkItemActions(db);
    const results = await Promise.all(Array.from({ length: 25 }, (_, index) =>
      items.createWorkItem.handler({ userId: member.id }, { projectId: project.id, title: `Item ${index}` })));
    expect(results.map((item) => item.sequence).sort((a, b) => a - b)).toEqual(Array.from({ length: 25 }, (_, index) => index + 1));
  } finally {
    await db.delete(workspaces).where(eq(workspaces.id, workspace.id));
    // Committed rows are visible to the gate tests that count users and workspaces, so remove them.
    if (memberId) await db.delete(users).where(eq(users.id, memberId));
  }
});

test.concurrent("a failed creation does not burn a sequence number", async () => {
  await withRollback(db, async (transaction) => {
    const { items, member, project, create } = await setup(transaction);
    await expect(items.createWorkItem.handler({ userId: member.id }, { projectId: project.id, title: "Bad", stateId: crypto.randomUUID() })).rejects.toMatchObject({ status: 400 });
    expect((await create()).sequence).toBe(1);
  });
});

test.concurrent("guests and outsiders cannot create; guests can read", async () => {
  await withRollback(db, async (transaction) => {
    const { items, guest, project, create } = await setup(transaction);
    await create();
    await expect(create({}, guest.id)).rejects.toMatchObject({ status: 403 });
    expect(await items.listWorkItems.handler({ userId: guest.id }, { projectId: project.id })).toHaveLength(1);
  });
});

test.concurrent("update changes fields and writes one Activity per changed field with old, new, actor and source", async () => {
  await withRollback(db, async (transaction) => {
    const { items, member, create } = await setup(transaction);
    const item = await create({ title: "Old", priority: "low" });
    const states = await items.listStates.handler({ userId: member.id }, { projectId: item.projectId });
    const started = states.find((state) => state.group === "started")!;
    const updated = await items.updateWorkItem.handler({ userId: member.id, source: "cli" }, {
      workItemId: item.id, title: "New", priority: "low", stateId: started.id,
      description: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "hello world" }] }] },
    });
    expect(updated.title).toBe("New");
    expect(updated.stateId).toBe(started.id);
    expect(updated.descriptionText).toBe("hello world");
    const log = await items.listWorkItemActivities.handler({ userId: member.id }, { workItemId: item.id });
    const byField = Object.fromEntries(log.map((row) => [row.field, row]));
    expect(byField.title).toMatchObject({ oldValue: "Old", newValue: "New", actorId: member.id, source: "cli" });
    expect(byField.state).toMatchObject({ oldValue: item.stateId, newValue: started.id });
    expect(byField.description).toBeDefined();
    expect(byField.priority).toBeUndefined();
    expect(byField.created).toMatchObject({ actorId: member.id, source: "ui" });
  });
});

test.concurrent("description edits coalesce only for the same human actor and source within five minutes", async () => {
  await withRollback(db, async (transaction) => {
    const { items, projects, member, workspace, project, create } = await setup(transaction);
    const other = await createMemberFactory(transaction, workspace.id, "Member");
    await projects.addProjectMember.handler({ userId: member.id }, { projectId: project.id, userId: other.id, role: "Member" });
    const item = await create();
    const update = (userId: string, source: "ui" | "cli" | "ai", value: string) => items.updateWorkItem.handler(
      { userId, source },
      { workItemId: item.id, description: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: value }] }] } },
    );

    await update(member.id, "ui", "first");
    await update(member.id, "ui", "second");
    let descriptions = await transaction.select().from(activities).where(and(eq(activities.entityId, item.id), eq(activities.field, "description"))).orderBy(asc(activities.seq));
    expect(descriptions).toHaveLength(1);
    expect(descriptions[0]).toMatchObject({ oldValue: "", newValue: "second", actorId: member.id, source: "ui" });

    await update(other.id, "ui", "different actor");
    await update(other.id, "cli", "different source");
    await transaction.update(activities).set({ createdAt: sql`now() - interval '6 minutes'` }).where(eq(activities.entityId, item.id));
    await update(other.id, "cli", "after gap");
    await update(other.id, "ai", "ai one");
    await update(other.id, "ai", "ai two");
    descriptions = await transaction.select().from(activities).where(and(eq(activities.entityId, item.id), eq(activities.field, "description"))).orderBy(asc(activities.seq));
    expect(descriptions.map((row) => [row.actorId, row.source, row.newValue])).toEqual([
      [member.id, "ui", "second"], [other.id, "ui", "different actor"], [other.id, "cli", "different source"],
      [other.id, "cli", "after gap"], [other.id, "ai", "ai one"], [other.id, "ai", "ai two"],
    ]);

    await items.updateWorkItem.handler({ userId: other.id, source: "ui" }, { workItemId: item.id, title: "one" });
    await items.updateWorkItem.handler({ userId: other.id, source: "ui" }, { workItemId: item.id, title: "two" });
    expect(await transaction.select().from(activities).where(and(eq(activities.entityId, item.id), eq(activities.field, "title")))).toHaveLength(2);
  });
});

test.concurrent("a rejected update leaves no Activity behind", async () => {
  await withRollback(db, async (transaction) => {
    const { items, member, guest, create } = await setup(transaction);
    const item = await create();
    await expect(items.updateWorkItem.handler({ userId: guest.id }, { workItemId: item.id, title: "Nope" })).rejects.toMatchObject({ status: 403 });
    await expect(items.updateWorkItem.handler({ userId: member.id }, { workItemId: item.id, stateId: crypto.randomUUID() })).rejects.toMatchObject({ status: 400 });
    const rows = await transaction.select().from(activities).where(eq(activities.entityId, item.id)).orderBy(asc(activities.seq));
    expect(rows.map((row) => row.field)).toEqual(["created"]);
  });
});

test.concurrent("soft delete hides the work item, keeps the row and logs an Activity", async () => {
  await withRollback(db, async (transaction) => {
    const { items, member, workspace, create } = await setup(transaction);
    const item = await create();
    await items.deleteWorkItem.handler({ userId: member.id }, { workItemId: item.id });
    expect(await items.listWorkItems.handler({ userId: member.id }, { projectId: item.projectId })).toEqual([]);
    await expect(items.getWorkItem.handler({ userId: member.id }, { workspaceId: workspace.id, displayId: item.displayId })).rejects.toMatchObject({ status: 404 });
    await expect(items.updateWorkItem.handler({ userId: member.id }, { workItemId: item.id, title: "x" })).rejects.toMatchObject({ status: 404 });
    const rows = await transaction.select().from(activities).where(eq(activities.entityId, item.id)).orderBy(asc(activities.seq));
    expect(rows.map((row) => row.field)).toEqual(["created", "deleted"]);
  });
});

test.concurrent("project admins add, rename, reorder and remove states within a group, each logged", async () => {
  await withRollback(db, async (transaction) => {
    const { items, member, admin, project, create } = await setup(transaction);
    const as = (userId: string) => ({ userId });
    const added = await items.createState.handler(as(member.id), { projectId: project.id, group: "started", name: "In Review" });
    expect(added.group).toBe("started");
    await expect(items.createState.handler(as(admin.id), { projectId: project.id, group: "started", name: "In Review" })).rejects.toMatchObject({ status: 400 });
    const renamed = await items.updateState.handler(as(member.id), { stateId: added.id, name: "Review" });
    expect(renamed.name).toBe("Review");
    const started = (await items.listStates.handler(as(member.id), { projectId: project.id })).filter((state) => state.group === "started");
    expect(started.map((state) => state.name)).toEqual(["In Progress", "Review"]);
    const reordered = await items.reorderStates.handler(as(member.id), { projectId: project.id, group: "started", stateIds: [started[1]!.id, started[0]!.id] });
    expect(reordered.filter((state) => state.group === "started").map((state) => state.name)).toEqual(["Review", "In Progress"]);
    await expect(items.reorderStates.handler(as(member.id), { projectId: project.id, group: "started", stateIds: [started[0]!.id] })).rejects.toMatchObject({ status: 400 });
    const item = await create();
    await items.updateWorkItem.handler(as(member.id), { workItemId: item.id, stateId: added.id });
    await expect(items.deleteState.handler(as(member.id), { stateId: added.id })).rejects.toMatchObject({ status: 400 });
    await items.updateWorkItem.handler(as(member.id), { workItemId: item.id, stateId: item.stateId });
    expect(await items.deleteState.handler(as(member.id), { stateId: added.id })).toEqual({ removed: true });
    const rows = await transaction.select().from(activities).where(eq(activities.entityType, "state")).orderBy(asc(activities.seq));
    expect(rows.map((row) => row.field)).toEqual(["created", "name", "position", "position", "deleted"]);
  });
});

test.concurrent("non-admin project members cannot manage states", async () => {
  await withRollback(db, async (transaction) => {
    const { items, projects, member, project, workspace } = await setup(transaction);
    const other = await createMemberFactory(transaction, workspace.id, "Member");
    await projects.addProjectMember.handler({ userId: member.id }, { projectId: project.id, userId: other.id, role: "Member" });
    await expect(items.createState.handler({ userId: other.id }, { projectId: project.id, group: "started", name: "X" })).rejects.toMatchObject({ status: 403 });
  });
});

test.concurrent("description versions snapshot editing bursts and restore can be undone", async () => {
  await withRollback(db, async (transaction) => {
    const { items, member, create } = await setup(transaction);
    const item = await create();
    const doc = (text: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
    await items.updateWorkItem.handler({ userId: member.id }, { workItemId: item.id, description: doc("first") });
    expect(await items.listWorkItemDescriptionVersions.handler({ userId: member.id }, { workItemId: item.id })).toHaveLength(0);
    await items.updateWorkItem.handler({ userId: member.id }, { workItemId: item.id, description: doc("second") });
    let versions = await items.listWorkItemDescriptionVersions.handler({ userId: member.id }, { workItemId: item.id });
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ contentText: "first", createdBy: member.id, createdByName: "Test user" });
    await transaction.update((await import("@weft/db")).workItemDescriptionVersions).set({ createdAt: new Date(Date.now() - descriptionVersionIntervalMs - 1000) });
    await items.updateWorkItem.handler({ userId: member.id }, { workItemId: item.id, description: doc("third") });
    versions = await items.listWorkItemDescriptionVersions.handler({ userId: member.id }, { workItemId: item.id });
    const restored = await items.restoreWorkItemDescriptionVersion.handler({ userId: member.id }, { workItemId: item.id, versionId: versions[0]!.id });
    expect(restored.descriptionText).toBe("second");
    expect(await items.listWorkItemDescriptionVersions.handler({ userId: member.id }, { workItemId: item.id })).toHaveLength(3);
    const log = await items.listWorkItemActivities.handler({ userId: member.id }, { workItemId: item.id });
    expect(log.at(-1)).toMatchObject({ field: "description_restored", oldValue: "third", newValue: "second", actorId: member.id });
    await items.updateWorkItem.handler({ userId: member.id }, { workItemId: item.id, description: doc("after restore") });
    const after = await items.listWorkItemActivities.handler({ userId: member.id }, { workItemId: item.id });
    expect(after.filter((row) => row.field === "description_restored")).toHaveLength(1);
    expect(after.at(-1)).toMatchObject({ field: "description", oldValue: "second", newValue: "after restore" });
  });
});
