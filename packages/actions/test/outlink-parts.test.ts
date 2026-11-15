import { afterAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createDatabase, outlinks, workItems, type Database } from "@weft/db";
import { createCommentActions, createProjectActions, createWorkItemActions, withWrittenFormKey, dispatchLog } from "../src";
import { setOutlinkPart } from "../src/outlinks";
import { markdownParseStats } from "../src/markdown-doc";
import { createMemberFactory, createWorkspaceFactory, withRollback } from "../../db/src/test-helpers";

const { client, db } = createDatabase();
afterAll(async () => client.end());

// A write never parses another row: Outlinks are kept per part of a source (the description, each comment), each from the document its own write prepared.
const linkTo = (id: string) => `[[T|work-item:${id}]]`;
const heavy = (id: string) => `${"word ".repeat(19_000)} ${linkTo(id)}`;
const targetsOf = async (transaction: Database, sourceId: string) => [...new Set((await transaction.select().from(outlinks).where(eq(outlinks.sourceId, sourceId))).map((row) => row.targetId))].sort();

test.serial("a work item with three accepted 100 KB comments: another user's one-line comment and a one-line description edit are accepted while four accounts loop heavy writes", async () => {
  await withRollback(db, async (transaction) => {
    const workspace = await createWorkspaceFactory(transaction);
    const owner = await createMemberFactory(transaction, workspace.id, "Admin");
    const other = await createMemberFactory(transaction, workspace.id, "Member");
    const projectActions = createProjectActions(transaction);
    const project = await projectActions.createProject.handler({ userId: owner.id }, { workspaceId: workspace.id, name: "Parts", key: "PT", visibility: "public" });
    await projectActions.addProjectMember.handler({ userId: owner.id }, { projectId: project.id, userId: other.id, role: "Member" });
    const items = createWorkItemActions(transaction), comments = createCommentActions(transaction);
    const targets = await Promise.all(["A", "B", "C", "D"].map((title) => items.createWorkItem.handler({ userId: owner.id }, { projectId: project.id, title })));
    const source = await items.createWorkItem.handler({ userId: owner.id }, { projectId: project.id, title: "Source", descriptionMarkdown: `Plan ${linkTo(targets[3]!.id)}` });
    for (let index = 0; index < 3; index++) await comments.createComment.handler({ userId: owner.id }, { workItemId: source.id, bodyMarkdown: heavy(targets[index]!.id) });
    expect(await targetsOf(transaction, source.id)).toEqual(targets.map((target) => target.id).sort());

    // Four accounts loop heavy writes on the same item while the bystander writes.
    let stop = false;
    const attackers = Array.from({ length: 4 }, (_, index) => (async () => {
      while (!stop) await withWrittenFormKey(`user:attacker-${index}`, () => comments.createComment.handler({ userId: owner.id }, { workItemId: source.id, bodyMarkdown: heavy(targets[0]!.id) })).catch(() => undefined);
    })());
    await Bun.sleep(300);
    const before = dispatchLog.length;
    let started = performance.now();
    await withWrittenFormKey("user:bystander", () => comments.createComment.handler({ userId: other.id }, { workItemId: source.id, bodyMarkdown: `short note ${linkTo(targets[3]!.id)}` }));
    const commentSeconds = (performance.now() - started) / 1000;
    started = performance.now();
    await withWrittenFormKey("user:bystander", () => items.updateWorkItem.handler({ userId: other.id }, { workItemId: source.id, descriptionMarkdown: `Plan v2 ${linkTo(targets[3]!.id)}` }));
    const descriptionSeconds = (performance.now() - started) / 1000;
    stop = true;
    await Promise.all(attackers);
    // Both writes were accepted while four accounts looped heavy writes. (That a write converts no other row is asserted by the parse-count test below, not by a timing bound.)
    expect(commentSeconds).toBeLessThan(10);
    expect(descriptionSeconds).toBeLessThan(10);
    void before;
  });
}, 180_000);

test.serial("links are per part: editing or deleting one part removes only its own links", async () => {
  await withRollback(db, async (transaction) => {
    const workspace = await createWorkspaceFactory(transaction);
    const owner = await createMemberFactory(transaction, workspace.id, "Admin");
    const project = await createProjectActions(transaction).createProject.handler({ userId: owner.id }, { workspaceId: workspace.id, name: "Parts", key: "PT", visibility: "public" });
    const items = createWorkItemActions(transaction), comments = createCommentActions(transaction);
    const [a, b, c] = await Promise.all(["A", "B", "C"].map((title) => items.createWorkItem.handler({ userId: owner.id }, { projectId: project.id, title })));
    const source = await items.createWorkItem.handler({ userId: owner.id }, { projectId: project.id, title: "Source", descriptionMarkdown: linkTo(a!.id) });
    const first = await comments.createComment.handler({ userId: owner.id }, { workItemId: source.id, bodyMarkdown: linkTo(b!.id) });
    await comments.createComment.handler({ userId: owner.id }, { workItemId: source.id, bodyMarkdown: linkTo(c!.id) });
    expect(await targetsOf(transaction, source.id)).toEqual([a!.id, b!.id, c!.id].sort());
    await items.updateWorkItem.handler({ userId: owner.id }, { workItemId: source.id, descriptionMarkdown: "no link now" });
    expect(await targetsOf(transaction, source.id)).toEqual([b!.id, c!.id].sort());
    await comments.updateComment.handler({ userId: owner.id }, { commentId: first.id, bodyMarkdown: linkTo(a!.id) });
    expect(await targetsOf(transaction, source.id)).toEqual([a!.id, c!.id].sort());
    await comments.deleteComment.handler({ userId: owner.id }, { commentId: first.id });
    expect(await targetsOf(transaction, source.id)).toEqual([c!.id]);
    // The same target from two parts is one link, and it stays until the last part drops it.
    await items.updateWorkItem.handler({ userId: owner.id }, { workItemId: source.id, descriptionMarkdown: linkTo(c!.id) });
    expect(await targetsOf(transaction, source.id)).toEqual([c!.id]);
    await items.updateWorkItem.handler({ userId: owner.id }, { workItemId: source.id, descriptionMarkdown: "plain again" });
    expect(await targetsOf(transaction, source.id)).toEqual([c!.id]);
  });
});

test("a part that could not be derived keeps its previous links; one that was read replaces them", async () => {
  await withRollback(db, async (transaction) => {
    const workspace = await createWorkspaceFactory(transaction);
    const owner = await createMemberFactory(transaction, workspace.id, "Admin");
    const project = await createProjectActions(transaction).createProject.handler({ userId: owner.id }, { workspaceId: workspace.id, name: "Parts", key: "PT", visibility: "public" });
    const items = createWorkItemActions(transaction);
    const target = await items.createWorkItem.handler({ userId: owner.id }, { projectId: project.id, title: "T" });
    const source = await items.createWorkItem.handler({ userId: owner.id }, { projectId: project.id, title: "S", descriptionMarkdown: linkTo(target.id) });
    await setOutlinkPart(transaction, "work-item", source.id, "body", null);
    expect(await targetsOf(transaction, source.id)).toEqual([target.id]);
    await setOutlinkPart(transaction, "work-item", source.id, "body", []);
    expect(await targetsOf(transaction, source.id)).toEqual([]);
  });
});

test("a read serves the stored description document and does not parse the Markdown", async () => {
  await withRollback(db, async (transaction) => {
    const workspace = await createWorkspaceFactory(transaction);
    const owner = await createMemberFactory(transaction, workspace.id, "Admin");
    const project = await createProjectActions(transaction).createProject.handler({ userId: owner.id }, { workspaceId: workspace.id, name: "Parts", key: "PT", visibility: "public" });
    const items = createWorkItemActions(transaction);
    const source = await items.createWorkItem.handler({ userId: owner.id }, { projectId: project.id, title: "S", descriptionMarkdown: `${"my_var_name and `code` www.a.com ".repeat(5_000)}` });
    const [row] = await transaction.select({ doc: workItems.descriptionDoc }).from(workItems).where(eq(workItems.id, source.id));
    expect(row!.doc).toMatchObject({ type: "doc" });
    const before = dispatchLog.length;
    const read: any = await items.getWorkItem.handler({ userId: owner.id }, { workspaceId: workspace.id, displayId: source.displayId });
    expect(read.description.type).toBe("doc");
    expect(dispatchLog.length).toBe(before);
  });
}, 120_000);

// A write converts nothing but its own text: the number of parses and worker jobs of a one-line comment and of a one-line description edit does not depend on how much other text the item holds.
test.serial("a write converts 0 other rows: parse and worker-job counts are the same with or without 300 KB of other comments", async () => {
  await withRollback(db, async (transaction) => {
    const workspace = await createWorkspaceFactory(transaction);
    const owner = await createMemberFactory(transaction, workspace.id, "Admin");
    const project = await createProjectActions(transaction).createProject.handler({ userId: owner.id }, { workspaceId: workspace.id, name: "Counts", key: "CN", visibility: "public" });
    const items = createWorkItemActions(transaction), comments = createCommentActions(transaction);
    const target = await items.createWorkItem.handler({ userId: owner.id }, { projectId: project.id, title: "T" });
    const light = await items.createWorkItem.handler({ userId: owner.id }, { projectId: project.id, title: "Light", descriptionMarkdown: `d ${linkTo(target.id)}` });
    const loaded = await items.createWorkItem.handler({ userId: owner.id }, { projectId: project.id, title: "Loaded", descriptionMarkdown: `d ${linkTo(target.id)}` });
    for (let index = 0; index < 3; index++) await comments.createComment.handler({ userId: owner.id }, { workItemId: loaded.id, bodyMarkdown: heavy(target.id) });
    const measure = async (itemId: string) => {
      const parsesBefore = markdownParseStats.parses, jobsBefore = dispatchLog.length;
      await comments.createComment.handler({ userId: owner.id }, { workItemId: itemId, bodyMarkdown: `short ${linkTo(target.id)}` });
      await items.updateWorkItem.handler({ userId: owner.id }, { workItemId: itemId, descriptionMarkdown: `edited ${linkTo(target.id)}` });
      return { parses: markdownParseStats.parses - parsesBefore, jobs: dispatchLog.length - jobsBefore };
    };
    const withoutOthers = await measure(light.id), withOthers = await measure(loaded.id);
    expect(withOthers).toEqual(withoutOthers);
  });
}, 120_000);
