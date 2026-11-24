import { afterAll, expect, test } from "bun:test";
import { and, asc, eq, sql } from "drizzle-orm";
import { activities, assets, createDatabase, users, workspaces, workItems, type Database } from "@weft/db";
import { createAgentActions, createCommentActions, createProjectActions, createWorkItemActions, descriptionVersionIntervalMs } from "../src";
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

test("work item descriptions reject an image owned by another item", async () => {
  await withRollback(db, async (transaction) => {
    const { member, admin, project, workspace, create, projects } = await setup(transaction);
    const source = await create({ title: "Source" });
    const privateProject = await projects.createProject.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Private assets", key: "PRV", visibility: "private" });
    const foreign = await createWorkItemActions(transaction).createWorkItem.handler({ userId: admin.id }, { projectId: privateProject.id, title: "Foreign" });
    const assetId = crypto.randomUUID();
    await transaction.insert(assets).values({ id: assetId, workspaceId: workspace.id, projectId: privateProject.id, ownerType: "work_item", ownerId: foreign.id, uploaderId: admin.id, storageKey: `foreign/${assetId}`, filename: "foreign.png", contentType: "image/png", size: 10, status: "uploaded", uploadedAt: new Date() });
    const description = { type: "doc", content: [{ type: "paragraph", content: [{ type: "assetImage", attrs: { assetId } }] }] };
    await expect(createWorkItemActions(transaction).createWorkItem.handler({ userId: member.id }, { projectId: project.id, title: "Invalid image", description })).rejects.toMatchObject({ status: 400 });
    await expect(createWorkItemActions(transaction).updateWorkItem.handler({ userId: member.id }, { workItemId: source.id, description })).rejects.toMatchObject({ status: 400 });
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
    const [stored] = await transaction.select({ markdown: workItems.descriptionMarkdown, legacy: workItems.description }).from(workItems).where(eq(workItems.id, item.id));
    expect(stored?.markdown).toBe("## Plan\n\n- one");
    expect(stored?.legacy).toBeNull();
    expect(item.descriptionMarkdown).toContain("## Plan");
    const updated = await items.updateWorkItem.handler({ userId: member.id }, { workItemId: item.id, descriptionMarkdown: "**done**" });
    expect(updated.descriptionMarkdown).toBe("**done**");
    const activity = await items.listWorkItemActivities.handler({ userId: member.id }, { workItemId: item.id });
    expect(activity.find((entry) => entry.field === "description")?.newValue).toBe("**done**");
    await expect(items.updateWorkItem.handler({ userId: member.id }, { workItemId: item.id, description: { type: "doc", content: [] }, descriptionMarkdown: "md" } as never)).rejects.toThrow("Send either descriptionMarkdown");
  });
});

test.concurrent("work item create and update save legacy alignment with a warning", async () => {
  await withRollback(db, async (transaction) => {
    const { items, member, project } = await setup(transaction);
    const description = { type: "doc", content: [{ type: "paragraph", attrs: { textAlign: "center" }, content: [{ type: "text", text: "Aligned" }] }] };
    const created = await items.createWorkItem.handler({ userId: member.id }, { projectId: project.id, title: "Legacy alignment", description });
    expect(created.descriptionMarkdown).toContain("Aligned");
    expect(created.descriptionMarkdownWarningDetails).toContainEqual(expect.objectContaining({ code: "attribute-not-persisted", message: expect.stringContaining("text alignment") }));
    const updated = await items.updateWorkItem.handler({ userId: member.id }, { workItemId: created.id, description });
    expect(updated.descriptionMarkdownWarningDetails).toContainEqual(expect.objectContaining({ code: "attribute-not-persisted" }));
  });
});

test.concurrent("work item description writes accept every code-block language spelling", async () => {
  await withRollback(db, async (transaction) => {
    const { items, member, project } = await setup(transaction);
    const variants = [undefined, null, "", "typescript"] as const;
    for (const [index, language] of variants.entries()) {
      const block = { type: "codeBlock", ...(index === 0 ? {} : { attrs: { language } }), content: [{ type: "text", text: "Code block" }] };
      const created = await items.createWorkItem.handler({ userId: member.id }, { projectId: project.id, title: `Code ${index}`, description: { type: "doc", content: [block] } });
      expect(created.descriptionMarkdown).toContain("Code block");
      const updated = await items.updateWorkItem.handler({ userId: member.id }, { workItemId: created.id, description: { type: "doc", content: [block] } });
      expect(updated.descriptionMarkdown).toContain("Code block");
    }
  });
});

test.concurrent("bare Work item keys in descriptions become stable links that survive a Project key rename", async () => {
  await withRollback(db, async (transaction) => {
    const { items, projects, admin, member, project, workspace } = await setup(transaction);
    const target = await items.createWorkItem.handler({ userId: member.id }, { projectId: project.id, title: "Target" });
    const source = await items.createWorkItem.handler({ userId: member.id }, { projectId: project.id, title: "Source", descriptionMarkdown: `See MOB-${target.sequence}` });
    expect(source.descriptionMarkdown).toBe(`See MOB-${target.sequence}`);
    await projects.renameProjectKey.handler({ userId: admin.id }, { projectId: project.id, key: "APP" });
    const reread = await items.getWorkItem.handler({ userId: member.id }, { workspaceId: workspace.id, displayId: `APP-${source.sequence}` });
    expect(JSON.stringify(reread.description)).toContain(target.id);
  });
});

test.concurrent("an unresolved private reference stays plain text, while existing hidden links stay inert", async () => {
  await withRollback(db, async (transaction) => {
    const { items, projects, admin, member, project, workspace } = await setup(transaction);
    const hiddenProject = await projects.createProject.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Private", key: "SEC", visibility: "private" });
    const hidden = await items.createWorkItem.handler({ userId: admin.id }, { projectId: hiddenProject.id, title: "Secret" });
    const source = await items.createWorkItem.handler({ userId: member.id }, { projectId: project.id, title: "Visible", descriptionMarkdown: `[[Secret|work-item:${hidden.id}]]` });
    expect(source.descriptionMarkdownWarningDetails.map(({ code }) => code)).toContain("unresolved-reference");
    const comments = createCommentActions(transaction);
    await comments.createComment.handler({ userId: admin.id }, { workItemId: source.id, bodyMarkdown: `[[Secret|work-item:${hidden.id}]]` });
    const listedComment = (await comments.listComments.handler({ userId: member.id }, { workItemId: source.id }))[0]!;
    expect(listedComment.bodyText).toBe("Secret");
    expect((listedComment.body as any).content[0].content[0].marks[0].attrs.unavailable).toBe(true);
    expect(listedComment.markdown).toContain(hidden.id);
    const read = await items.getWorkItem.handler({ userId: member.id }, { workspaceId: workspace.id, displayId: source.displayId });
    expect(read.descriptionText).toContain("[[Secret|work-item:");
  });
});

test.concurrent("a description rejects unknown nodes but preserves unsupported HTML as warned text", async () => {
  await withRollback(db, async (transaction) => {
    const { items, member, create } = await setup(transaction);
    const item = await create();
    await expect(items.updateWorkItem.handler({ userId: member.id }, { workItemId: item.id, description: { type: "doc", content: [{ type: "unsupportedWidget", attrs: { payload: "keep me" } }] } })).rejects.toThrow(/can't be saved/);
    const updated = await items.updateWorkItem.handler({ userId: member.id }, { workItemId: item.id, descriptionMarkdown: "<script>keep me</script>" });
    expect(updated.descriptionText).toContain("keep me");
    expect(updated.descriptionMarkdownWarningDetails.map(({ code }) => code)).toContain("unsupported-html");
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
    expect(versions[0]?.contentMarkdown).toBe("first");
    await transaction.update((await import("@weft/db")).workItemDescriptionVersions).set({ createdAt: new Date(Date.now() - descriptionVersionIntervalMs - 1000) });
    await items.updateWorkItem.handler({ userId: member.id }, { workItemId: item.id, description: doc("third") });
    versions = await items.listWorkItemDescriptionVersions.handler({ userId: member.id }, { workItemId: item.id });
    const restored = await items.restoreWorkItemDescriptionVersion.handler({ userId: member.id }, { workItemId: item.id, versionId: versions[0]!.id });
    expect(restored.descriptionText).toBe("second");
    expect(restored.descriptionMarkdown).toBe("second");
    expect(await items.listWorkItemDescriptionVersions.handler({ userId: member.id }, { workItemId: item.id })).toHaveLength(3);
    const log = await items.listWorkItemActivities.handler({ userId: member.id }, { workItemId: item.id });
    expect(log.at(-1)).toMatchObject({ field: "description_restored", oldValue: "third", newValue: "second", actorId: member.id });
    await items.updateWorkItem.handler({ userId: member.id }, { workItemId: item.id, description: doc("after restore") });
    const after = await items.listWorkItemActivities.handler({ userId: member.id }, { workItemId: item.id });
    expect(after.filter((row) => row.field === "description_restored")).toHaveLength(1);
    expect(after.at(-1)).toMatchObject({ field: "description", oldValue: "second", newValue: "after restore" });
  });
});

test.concurrent("description versions never hold the same text twice", async () => {
  await withRollback(db, async (transaction) => {
    const { items, member, create } = await setup(transaction);
    const item = await create();
    const doc = (text: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
    const { workItemDescriptionVersions } = await import("@weft/db");
    const ageAllVersions = () => transaction.update(workItemDescriptionVersions).set({ createdAt: new Date(Date.now() - descriptionVersionIntervalMs - 1000) });
    const listVersions = () => items.listWorkItemDescriptionVersions.handler({ userId: member.id }, { workItemId: item.id });
    const expectNoRepeatedText = async () => {
      const markdowns = (await listVersions()).map((version) => version.contentMarkdown);
      expect(new Set(markdowns).size).toBe(markdowns.length);
    };
    await items.updateWorkItem.handler({ userId: member.id }, { workItemId: item.id, description: doc("first") });
    await items.updateWorkItem.handler({ userId: member.id }, { workItemId: item.id, description: doc("second") });
    await ageAllVersions();
    await items.updateWorkItem.handler({ userId: member.id }, { workItemId: item.id, description: doc("third") });
    const [firstVersion] = (await listVersions()).filter((version) => version.contentMarkdown === "first");
    expect(firstVersion).toBeDefined();
    // Restoring "first" snapshots "third", then the text "first" lives in two places.
    await items.restoreWorkItemDescriptionVersion.handler({ userId: member.id }, { workItemId: item.id, versionId: firstVersion!.id });
    await ageAllVersions();
    // Editing after the interval must not snapshot "first" again, it already exists.
    await items.updateWorkItem.handler({ userId: member.id }, { workItemId: item.id, description: doc("fourth") });
    await expectNoRepeatedText();
    // Restoring the same version twice in a row must not duplicate its text either.
    await items.restoreWorkItemDescriptionVersion.handler({ userId: member.id }, { workItemId: item.id, versionId: firstVersion!.id });
    await items.restoreWorkItemDescriptionVersion.handler({ userId: member.id }, { workItemId: item.id, versionId: firstVersion!.id });
    await expectNoRepeatedText();
  });
});

test.concurrent("the agent-id hint names only Agents of the project's own workspace, never another workspace's Agent", async () => {
  await withRollback(db, async (transaction) => {
    const { items, member, project, admin, workspace } = await setup(transaction);
    const agents = createAgentActions(transaction);
    const own = await agents.createAgent.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Own", instructions: "x", model: "default" });
    const item = await items.createWorkItem.handler({ userId: member.id }, { projectId: project.id, title: "Hint" });
    await expect(items.updateWorkItem.handler({ userId: member.id }, { workItemId: item.id, assigneeIds: [own.id] })).rejects.toMatchObject({ message: expect.stringContaining(own.userId) });
    const otherWorkspace = await createWorkspaceFactory(transaction);
    const otherAdmin = await createMemberFactory(transaction, otherWorkspace.id, "Admin");
    const foreign = await agents.createAgent.handler({ userId: otherAdmin.id }, { workspaceId: otherWorkspace.id, name: "Foreign", instructions: "x", model: "default" });
    const refused = await items.updateWorkItem.handler({ userId: member.id }, { workItemId: item.id, assigneeIds: [foreign.id] }).catch((error: Error) => error);
    expect(refused).toBeInstanceOf(Error);
    expect((refused as Error).message).not.toContain(foreign.userId);
    expect((refused as Error).message).toContain("Assignees must be project members");
  });
});
