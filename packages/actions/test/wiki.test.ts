import { afterAll, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq, inArray, sql } from "drizzle-orm";
import { assets, collections, createDatabase, outlinks, projectMembers, projects, schema, users, wikiPageVersions, wikiPages, type Database } from "@weft/db";
import { ActionError, createActionList, requireWikiPageAccess, createAgentActions, createAssetActions, createProjectActions, createWikiActions, versionIntervalMs, wikiContentFromYState, wikiYStateFromContent, type AssetStorage } from "../src";
import { createMemberFactory, createWorkspaceFactory, withRollback } from "../../db/src/test-helpers";

const { client, db } = createDatabase();
afterAll(async () => client.end());

const doc = (text: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });

async function setup(transaction: Database) {
  const clock = { time: new Date("2026-01-01T00:00:00Z") };
  const workspace = await createWorkspaceFactory(transaction);
  const alice = await createMemberFactory(transaction, workspace.id, "Member");
  const bob = await createMemberFactory(transaction, workspace.id, "Member");
  const admin = await createMemberFactory(transaction, workspace.id, "Admin");
  const guest = await createMemberFactory(transaction, workspace.id, "Guest");
  const wiki = createWikiActions(transaction, () => clock.time);
  const advance = (ms: number) => { clock.time = new Date(clock.time.getTime() + ms); };
  const create = (userId: string, title: string, extra: Record<string, unknown> = {}) =>
    wiki.createWikiPage.handler({ userId }, { workspaceId: workspace.id, title, ...extra });
  const titles = async (userId: string) => (await wiki.listWikiPages.handler({ userId }, { workspaceId: workspace.id })).map((page) => page.title);
  return { workspace, alice, bob, admin, guest, wiki, create, titles, advance };
}

const failure = async (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => error as ActionError);

test.concurrent("Wiki pages accept and return Markdown, and reject competing content fields", async () => {
  await withRollback(db, async (tx) => {
    const { workspace, alice, wiki } = await setup(tx);
    const page = await wiki.createWikiPage.handler({ userId: alice.id }, { workspaceId: workspace.id, title: "Markdown", contentMarkdown: "## Plan\n\n| A | B |\n| --- | --- |\n| one | two |" });
    expect(page.contentMarkdown).toContain("| one | two |");
    const { wikiPages } = await import("@weft/db");
    const [stored] = await tx.select().from(wikiPages).where(eq(wikiPages.id, page.id));
    expect(stored?.contentMarkdown).toBe(page.contentMarkdown);
    const updated = await wiki.updateWikiPage.handler({ userId: alice.id }, { pageId: page.id, contentMarkdown: "- done" });
    expect(updated.contentMarkdown).toContain("- done");
    const [updatedStored] = await tx.select().from(wikiPages).where(eq(wikiPages.id, page.id));
    expect(updatedStored?.contentMarkdown).toBe(updated.contentMarkdown);
    await expect(wiki.updateWikiPage.handler({ userId: alice.id }, { pageId: page.id, content: doc("doc"), contentMarkdown: "md" } as never)).rejects.toThrow("Send either contentMarkdown");
  });
});

test("Wiki page create and update reject an image owned by another page", async () => {
  await withRollback(db, async (tx) => {
    const { workspace, alice, bob, create, wiki } = await setup(tx);
    const foreign = await create(bob.id, "Foreign", { access: "private" });
    const source = await create(alice.id, "Source");
    const assetId = crypto.randomUUID();
    await tx.insert(assets).values({ id: assetId, workspaceId: workspace.id, projectId: null, ownerType: "wiki_page", ownerId: foreign.id, uploaderId: alice.id, storageKey: `foreign/${assetId}`, filename: "foreign.png", contentType: "image/png", size: 10, status: "uploaded", uploadedAt: new Date() });
    const content = { type: "doc", content: [{ type: "paragraph", content: [{ type: "assetImage", attrs: { assetId } }] }] };
    await expect(create(alice.id, "Invalid create", { content })).rejects.toMatchObject({ status: 400 });
    await expect(wiki.updateWikiPage.handler({ userId: alice.id }, { pageId: source.id, content })).rejects.toMatchObject({ status: 400 });
  });
});

test.concurrent("Wiki page create and update save legacy alignment with the same warning code", async () => {
  await withRollback(db, async (tx) => {
    const { workspace, alice, wiki } = await setup(tx);
    const content = { type: "doc", content: [{ type: "paragraph", attrs: { textAlign: "center" }, content: [{ type: "text", text: "Aligned" }] }] };
    const created = await wiki.createWikiPage.handler({ userId: alice.id }, { workspaceId: workspace.id, title: "Legacy alignment", content });
    expect(created.contentMarkdown).toContain("Aligned");
    expect(created.contentMarkdownWarningDetails).toContainEqual(expect.objectContaining({ code: "attribute-not-persisted", message: expect.stringContaining("text alignment") }));
    const updated = await wiki.updateWikiPage.handler({ userId: alice.id }, { pageId: created.id, content });
    expect(updated.contentMarkdownWarningDetails).toContainEqual(expect.objectContaining({ code: "attribute-not-persisted" }));
  });
});

test.concurrent("a forged javascript: link inside live Yjs state is dropped on the way out of getWikiPage and the Markdown export", async () => {
  await withRollback(db, async (tx) => {
    const { workspace, alice, wiki } = await setup(tx);
    const created = await wiki.createWikiPage.handler({ userId: alice.id }, { workspaceId: workspace.id, title: "Forged", content: doc("anchor") });
    const forged = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "click me", marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }] }, { type: "text", text: " safe", marks: [{ type: "textStyle", attrs: { color: "url(javascript:x)" } }] }] }, { type: "assetImage", attrs: { assetId: "not-a-uuid" } }, { type: "assetImage", attrs: { assetId: "00000000-0000-4000-8000-0000000000ff" } }] };
    await tx.update(wikiPages).set({ ydocState: wikiYStateFromContent(forged), content: forged }).where(eq(wikiPages.id, created.id));
    const page = await wiki.getWikiPage.handler({ userId: alice.id }, { pageId: created.id });
    expect(JSON.stringify(page.content)).not.toContain("javascript:");
    expect(JSON.stringify(page.content)).not.toContain("url(");
    expect(page.contentMarkdown).not.toContain("javascript:");
    expect(page.contentMarkdown).toContain("click me");
    expect(JSON.stringify(page.content)).not.toContain("not-a-uuid");
    expect(JSON.stringify(page.content)).not.toContain("0000000000ff");
    expect(page.contentMarkdown).not.toContain("![[asset:");
    const exported = await wiki.getWikiPage.handler({ userId: alice.id }, { pageId: created.id });
    expect(exported.contentMarkdown).not.toContain("javascript:");
    // The stored Yjs state is left alone so comment anchors keep working.
    const [row] = await tx.select({ state: wikiPages.ydocState }).from(wikiPages).where(eq(wikiPages.id, created.id));
    expect(JSON.stringify(wikiContentFromYState(row!.state!))).toContain("javascript:");
  });
});

test.concurrent("a non-uuid image id is a 400 asset-invalid on the API write path, not a database cast error", async () => {
  await withRollback(db, async (tx) => {
    const { workspace, alice, wiki } = await setup(tx);
    const withImage = (assetId: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "x" }] }, { type: "assetImage", attrs: { assetId } }] });
    await expect(wiki.createWikiPage.handler({ userId: alice.id }, { workspaceId: workspace.id, title: "Bad image", content: withImage("not-a-uuid") })).rejects.toMatchObject({ status: 400, code: "asset-invalid" });
    await expect(wiki.createWikiPage.handler({ userId: alice.id }, { workspaceId: workspace.id, title: "Missing image", content: withImage("00000000-0000-4000-8000-000000000000") })).rejects.toMatchObject({ status: 400, code: "asset-unavailable" });
  });
});

test.concurrent("Wiki page create and update accept every code-block language spelling", async () => {
  await withRollback(db, async (tx) => {
    const { workspace, alice, wiki } = await setup(tx);
    const variants = [undefined, null, "", "typescript"] as const;
    for (const [index, language] of variants.entries()) {
      const block = { type: "codeBlock", ...(index === 0 ? {} : { attrs: { language } }), content: [{ type: "text", text: "Code block" }] };
      const created = await wiki.createWikiPage.handler({ userId: alice.id }, { workspaceId: workspace.id, title: `Code ${index}`, content: { type: "doc", content: [block] } });
      expect(created.contentMarkdown).toContain("Code block");
      const updated = await wiki.updateWikiPage.handler({ userId: alice.id }, { pageId: created.id, content: { type: "doc", content: [block] } });
      expect(updated.contentMarkdown).toContain("Code block");
    }
  });
});

test.concurrent("Wiki page reads derive Written form from Yjs state instead of stale columns", async () => {
  await withRollback(db, async (tx) => {
    const { alice, wiki, create } = await setup(tx);
    const page = await create(alice.id, "Yjs is current", { contentMarkdown: "Content from Yjs" });
    await tx.update(wikiPages).set({ content: doc("stale JSON"), contentMarkdown: "stale Markdown", contentText: "stale text" }).where(eq(wikiPages.id, page.id));
    const read = await wiki.getWikiPage.handler({ userId: alice.id }, { pageId: page.id });
    expect(read.contentMarkdown).toBe("Content from Yjs");
    expect(read.contentText).toBe("Content from Yjs");
    expect(read.content).not.toEqual(doc("stale JSON"));
  });
});

test.concurrent("restoring a Wiki version derives Markdown from Yjs content and rebuilds Outlinks", async () => {
  await withRollback(db, async (tx) => {
    const { alice, wiki, create } = await setup(tx);
    const oldTarget = await create(alice.id, "Old link target");
    const newTarget = await create(alice.id, "New link target");
    const source = await create(alice.id, "Restore links", { contentMarkdown: `[[Old link target|wiki:${oldTarget.id}]]` });
    await wiki.updateWikiPage.handler({ userId: alice.id, source: "ai" }, { pageId: source.id, contentMarkdown: `[[New link target|wiki:${newTarget.id}]]` });
    expect(await tx.select({ targetId: outlinks.targetId }).from(outlinks).where(eq(outlinks.sourceId, source.id))).toMatchObject([{ targetId: newTarget.id }]);
    const [version] = await tx.select().from(wikiPageVersions).where(eq(wikiPageVersions.pageId, source.id));
    expect(version).toBeDefined();
    await tx.update(wikiPageVersions).set({ contentMarkdown: "stale Markdown" }).where(eq(wikiPageVersions.id, version!.id));
    const restored = await wiki.restoreWikiPageVersion.handler({ userId: alice.id }, { pageId: source.id, versionId: version!.id });
    expect(restored.contentMarkdown).toContain(`wiki:${oldTarget.id}`);
    expect(await tx.select({ targetId: outlinks.targetId }).from(outlinks).where(eq(outlinks.sourceId, source.id))).toMatchObject([{ targetId: oldTarget.id }]);
  });
});

test.concurrent("creating a page import keeps unresolved references as warned plain text", async () => {
  await withRollback(db, async (tx) => {
    const { workspace, alice, wiki } = await setup(tx);
    const page = await wiki.createWikiPage.handler({ userId: alice.id }, {
      workspaceId: workspace.id, title: "Imported", contentMarkdown: "<custom-tag>keep this</custom-tag>\n\n[[Missing page]]",
    });
    expect(page.contentMarkdownWarningDetails.map(({ code }) => code)).toEqual(expect.arrayContaining(["unsupported-html", "unresolved-reference"]));
    expect(page.contentText).toContain("keep this");
    expect(page.contentText).toContain("[[Missing page]]");
  });
});

test.concurrent("creating a Wiki page stores a resolved stable reference and rebuilds its backlink", async () => {
  await withRollback(db, async (tx) => {
    const { workspace, alice, wiki } = await setup(tx);
    const target = await wiki.createWikiPage.handler({ userId: alice.id }, { workspaceId: workspace.id, title: "Reference page" });
    const source = await wiki.createWikiPage.handler({ userId: alice.id }, { workspaceId: workspace.id, title: "Feature notes", contentMarkdown: ["Initial note.", "", `[[Reference page|wiki:${target.id}]]`, "", "```diff", "-old", "+new", "```", "", "```mermaid", "flowchart LR", "  A[Write] --> B[Review]", "```"].join("\n") });
    expect(source.contentMarkdown).toContain(`wiki:${target.id}`);
    expect(await tx.select({ sourceId: outlinks.sourceId, targetId: outlinks.targetId }).from(outlinks).where(eq(outlinks.targetId, target.id))).toContainEqual({ sourceId: source.id, targetId: target.id });
  });
});

test.concurrent("Wiki Markdown import preserves text and returns warnings for unsupported parts", async () => {
  await withRollback(db, async (tx) => {
    const { workspace, alice, wiki } = await setup(tx);
    const page = await wiki.createWikiPage.handler({ userId: alice.id }, {
      workspaceId: workspace.id, title: "Imported source", contentMarkdown: "<custom-widget>kept tag</custom-widget>\n\n[javascript label](javascript:alert(1))\n\n[[Missing page]]\n\n![remote image](https://example.test/image.png)\n\n| A | B |\n| --- | --- |\n| value |\n\n####### Deep heading",
    });
    expect(page.contentMarkdownWarningDetails.map(({ code }) => code)).toEqual(expect.arrayContaining(["unsupported-html", "external-image", "unsafe-link", "unresolved-reference", "irregular-table", "deep-heading"]));
    expect(page.contentText).toContain("kept tag");
  });
});

test.concurrent("a page export imported as a new page keeps the same Written form and document", async () => {
  await withRollback(db, async (tx) => {
    const { workspace, alice, wiki } = await setup(tx);
    const source = await wiki.createWikiPage.handler({ userId: alice.id }, { workspaceId: workspace.id, title: "Round trip" });
    await tx.insert(assets).values({ workspaceId: workspace.id, projectId: null, ownerType: "wiki_page", ownerId: source.id, uploaderId: alice.id, storageKey: `roundtrip/${source.id}`, filename: "diagram.png", contentType: "image/png", size: 10, status: "uploaded", uploadedAt: new Date() });
    const [asset] = await tx.select().from(assets).where(eq(assets.ownerId, source.id));
    const projectActions = createProjectActions(tx);
    const project = await projectActions.createProject.handler({ userId: alice.id }, { workspaceId: workspace.id, name: "Docs", key: "DOC", visibility: "public" });
    const item = await (await import("../src")).createWorkItemActions(tx).createWorkItem.handler({ userId: alice.id }, { projectId: project.id, title: "Release plan" });
    const target = await wiki.createWikiPage.handler({ userId: alice.id }, { workspaceId: workspace.id, title: "Sibling guide" });
    const written = `## Notes\n\n@{${alice.id}}\n\n![[asset:${asset!.id}|Diagram]]\n\n[[Release plan (DOC-${item.sequence})|work-item:${item.id}]]\n\n[[Sibling guide|wiki:${target.id}]]\n\n> [!note]\n> Keep this callout.`;
    const updated = await wiki.updateWikiPage.handler({ userId: alice.id }, { pageId: source.id, contentMarkdown: written });
    const { pageMarkdown, readableReferenceLabels, splitPageMarkdown } = await import("../../../apps/web/src/wiki-export");
    const linked = await (await import("../src")).createOutlinkActions(tx).listOutlinks.handler({ userId: alice.id }, { kind: "wiki", id: updated.id });
    expect(linked.map(({ id }) => id).sort()).toEqual([item.id, target.id].sort());
    const portable = await readableReferenceLabels(updated.contentMarkdown, async (kind, id, label) => {
      const targetRow = linked.find((entry) => entry.kind === kind && entry.id === id);
      return targetRow ? (kind === "work-item" && targetRow.displayId ? `${targetRow.title} (${targetRow.displayId})` : targetRow.title) : null;
    });
    const file = pageMarkdown(updated.title, portable);
    const importedFile = splitPageMarkdown("Round trip.md", file);
    const imported = await wiki.createWikiPage.handler({ userId: alice.id }, { workspaceId: workspace.id, title: importedFile.title, contentMarkdown: importedFile.contentMarkdown });
    expect(imported.contentMarkdown).toBe(updated.contentMarkdown);
    expect(imported.content).toEqual(updated.content);
    expect(imported.contentMarkdown).toContain(`![[asset:${asset!.id}|Diagram]]`);
    expect(imported.contentMarkdown).toContain(`@{${alice.name}|${alice.id}}`);
    expect(imported.contentMarkdown).toContain(`wiki:${target.id}`);
    expect(imported.contentMarkdown).toContain(`work-item:${item.id}`);
  });
});

test.concurrent("Markdown reads and imports obey private Collection access and page Locks", async () => {
  await withRollback(db, async (tx) => {
    const { workspace, alice, bob, wiki } = await setup(tx);
    const collection = await wiki.createCollection.handler({ userId: alice.id }, { workspaceId: workspace.id, name: "Private notes", visibility: "private" });
    const privatePage = await wiki.createWikiPage.handler({ userId: alice.id }, { workspaceId: workspace.id, collectionId: collection.id, title: "Private source", contentMarkdown: "Secret text" });
    await expect(wiki.getWikiPage.handler({ userId: bob.id }, { pageId: privatePage.id })).rejects.toMatchObject({ status: 404 });
    await expect(wiki.createWikiPage.handler({ userId: bob.id }, { workspaceId: workspace.id, collectionId: collection.id, title: "Imported secret", contentMarkdown: "Secret text" })).rejects.toMatchObject({ status: 404 });
    const lockedPage = await wiki.createWikiPage.handler({ userId: alice.id }, { workspaceId: workspace.id, title: "Locked source", contentMarkdown: "Before" });
    await wiki.lockWikiPage.handler({ userId: alice.id }, { pageId: lockedPage.id });
    await expect(wiki.updateWikiPage.handler({ userId: alice.id }, { pageId: lockedPage.id, contentMarkdown: "Imported over lock" })).rejects.toThrow("Page is locked");
    expect((await wiki.getWikiPage.handler({ userId: alice.id }, { pageId: lockedPage.id })).contentMarkdown).toBe("Before");
  });
});

test.concurrent("Page Written form resolves a bare Work item key to a stable link", async () => {
  await withRollback(db, async (tx) => {
    const { workspace, alice, admin, wiki } = await setup(tx);
    const projects = createProjectActions(tx);
    const project = await projects.createProject.handler({ userId: alice.id }, { workspaceId: workspace.id, name: "Docs", key: "DOC", visibility: "public" });
    const work = await (await import("../src")).createWorkItemActions(tx).createWorkItem.handler({ userId: alice.id }, { projectId: project.id, title: "Target" });
    const page = await wiki.createWikiPage.handler({ userId: alice.id }, { workspaceId: workspace.id, projectId: project.id, title: "Notes", contentMarkdown: `See DOC-${work.sequence}` });
    expect(page.contentMarkdown).toContain(`work-item:${work.id}`);
    const pageComment = await wiki.createWikiPageComment.handler({ userId: alice.id }, { pageId: page.id, anchor: "anchor", bodyMarkdown: `DOC-${work.sequence}` });
    expect(pageComment.bodyMarkdown).toBe(`DOC-${work.sequence}`);
    await projects.renameProjectKey.handler({ userId: admin.id }, { projectId: project.id, key: "DOCS" });
    const reread = await wiki.getWikiPage.handler({ userId: alice.id }, { pageId: page.id });
    expect(JSON.stringify(reread.content)).toContain(work.id);
  });
});

test.concurrent("unresolved private Work item references stay plain text with warnings", async () => {
  await withRollback(db, async (tx) => {
    const { workspace, alice, admin, wiki } = await setup(tx);
    const projects = createProjectActions(tx);
    const hiddenProject = await projects.createProject.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Private", key: "SEC", visibility: "private" });
    const hidden = await (await import("../src")).createWorkItemActions(tx).createWorkItem.handler({ userId: admin.id }, { projectId: hiddenProject.id, title: "Secret" });
    const page = await wiki.createWikiPage.handler({ userId: alice.id }, { workspaceId: workspace.id, title: "Public note", contentMarkdown: `[[Secret|work-item:${hidden.id}]]` });
    const createdComment = await wiki.createWikiPageComment.handler({ userId: alice.id }, { pageId: page.id, anchor: "anchor", bodyMarkdown: `[[Secret|work-item:${hidden.id}]]` });
    expect(createdComment.markdownWarningDetails.map(({ code }: { code: string }) => code)).toContain("unresolved-reference");
    const listedComment = (await wiki.listWikiPageComments.handler({ userId: alice.id }, { pageId: page.id }))[0]!;
    expect(listedComment.bodyText).toContain("[[Secret|work-item:");
    expect(listedComment.bodyMarkdown).toContain(hidden.id);
    const read = await wiki.getWikiPage.handler({ userId: alice.id }, { pageId: page.id });
    expect(JSON.stringify(read.content)).toContain("[[Secret|work-item:");
    expect(read.contentMarkdown).toContain(hidden.id);
  });
});

test.concurrent("Wiki Markdown mentions resolve visible people and refuse people without page access", async () => {
  await withRollback(db, async (tx) => {
    const { workspace, alice, bob, wiki } = await setup(tx);
    await tx.update(users).set({ name: "Page owner" }).where(eq(users.id, alice.id));
    await tx.update(users).set({ name: "Visible colleague" }).where(eq(users.id, bob.id));
    const page = await wiki.createWikiPage.handler({ userId: alice.id }, { workspaceId: workspace.id, title: "Mention resolution" });
    const updated = await wiki.updateWikiPage.handler({ userId: alice.id, source: "ai" }, { pageId: page.id, contentMarkdown: "Hello @{Visible colleague}" });
    expect(updated.contentMarkdown).toContain(`@{Visible colleague|${bob.id}}`);
    expect(JSON.stringify(updated.content)).toContain(`"id":"${bob.id}"`);

    const privatePage = await wiki.createWikiPage.handler({ userId: alice.id }, { workspaceId: workspace.id, title: "Private mention", access: "private" });
    await expect(wiki.updateWikiPage.handler({ userId: alice.id, source: "ai" }, { pageId: privatePage.id, contentMarkdown: "Hello @{Visible colleague}" })).rejects.toMatchObject({ status: 400 });
  });
});

test.concurrent("Wiki mention members include Agent and code-capability metadata", async () => {
  await withRollback(db, async (tx) => {
    const env = await setup(tx);
    const page = await env.create(env.alice.id, "Mentions");
    const agent = await createAgentActions(tx).createAgent.handler({ userId: env.admin.id }, { workspaceId: env.workspace.id, name: "Wiki helper", model: "default" });
    const listed = await env.wiki.listWikiPageMentionableMembers.handler({ userId: env.alice.id }, { pageId: page.id });
    expect(listed.find((person) => person.userId === agent.userId)).toMatchObject({ isAgent: true, codeCapable: false });
  });
});

test.concurrent("page lock is owner or Admin controlled and rejects every page content and placement writer", async () => {
  await withRollback(db, async (tx) => {
    const { workspace, alice, bob, admin, wiki, create } = await setup(tx);
    const page = await create(alice.id, "Locked guide");
    await wiki.updateWikiPage.handler({ userId: alice.id }, { pageId: page.id, content: doc("Version to restore") });
    const [version] = await wiki.listWikiPageVersions.handler({ userId: alice.id }, { pageId: page.id });
    await wiki.shareWikiPage.handler({ userId: alice.id }, { pageId: page.id, userId: bob.id, role: "edit" });
    expect((await failure(wiki.lockWikiPage.handler({ userId: bob.id }, { pageId: page.id })))?.status).toBe(403);
    await wiki.lockWikiPage.handler({ userId: admin.id }, { pageId: page.id });
    expect((await failure(wiki.updateWikiPage.handler({ userId: bob.id }, { pageId: page.id, title: "Changed" })))?.message).toContain("locked");
    expect((await failure(wiki.updateWikiPage.handler({ userId: bob.id }, { pageId: page.id, content: doc("Changed") })))?.message).toContain("locked");
    expect((await failure(wiki.updateWikiPage.handler({ userId: alice.id, source: "ai" }, { pageId: page.id, contentMarkdown: "Agent edit" })))?.status).toBe(409);
    expect((await failure(wiki.moveWikiPage.handler({ userId: alice.id }, { pageId: page.id, parentId: null })))?.message).toContain("locked");
    expect((await failure(wiki.movePageScope.handler({ userId: alice.id }, { pageId: page.id, projectId: null })))?.message).toContain("locked");
    expect((await failure(wiki.restoreWikiPageVersion.handler({ userId: alice.id }, { pageId: page.id, versionId: version!.id })))?.message).toContain("locked");
    await expect(wiki.unlockWikiPage.handler({ userId: bob.id }, { pageId: page.id })).rejects.toMatchObject({ status: 403 });
    await wiki.unlockWikiPage.handler({ userId: alice.id }, { pageId: page.id });
    expect((await wiki.listWikiPageActivities.handler({ userId: alice.id }, { pageId: page.id })).map(({ field }) => field)).toEqual(["created", "locked", "unlocked"]);
  });
});

test.concurrent("locked page still supports delete, archive, publish, and share actions", async () => {
  await withRollback(db, async (tx) => {
    const { workspace, alice, bob, wiki, create } = await setup(tx);
    const sharePage = await create(alice.id, "Share while locked");
    await wiki.lockWikiPage.handler({ userId: alice.id }, { pageId: sharePage.id });
    await wiki.shareWikiPage.handler({ userId: alice.id }, { pageId: sharePage.id, userId: bob.id, role: "view" });
    expect((await wiki.getWikiPage.handler({ userId: alice.id }, { pageId: sharePage.id })).locked).toBe(true);
    expect((await wiki.listWikiPageActivities.handler({ userId: alice.id }, { pageId: sharePage.id })).map(({ field }) => field)).toContain("locked");

    const publishPage = await create(alice.id, "Publish while locked");
    await wiki.lockWikiPage.handler({ userId: alice.id }, { pageId: publishPage.id });
    expect((await wiki.publishWikiPage.handler({ userId: alice.id }, { pageId: publishPage.id })).token).toBeTruthy();

    const archivePage = await create(alice.id, "Archive while locked");
    await wiki.lockWikiPage.handler({ userId: alice.id }, { pageId: archivePage.id });
    expect(await wiki.archiveWikiPage.handler({ userId: alice.id }, { pageId: archivePage.id })).toEqual({ archived: true });

    const deletePage = await create(alice.id, "Delete while locked");
    await wiki.lockWikiPage.handler({ userId: alice.id }, { pageId: deletePage.id });
    expect(await wiki.deleteWikiPage.handler({ userId: alice.id }, { pageId: deletePage.id })).toEqual({ deleted: 1 });
  });
});

test.concurrent("duplicates a visible page in place, copies its image assets, and hides pages the actor cannot see", async () => {
  await withRollback(db, async (tx) => {
    const { workspace, alice, bob } = await setup(tx);
    const project = await createProjectActions(tx).createProject.handler({ userId: alice.id }, {
      workspaceId: workspace.id, name: "Docs", key: "DOC", visibility: "public",
    });
    await createProjectActions(tx).addProjectMember.handler({ userId: alice.id }, { projectId: project.id, userId: bob.id, role: "Member" });
    const objects = new Set(["source/image"]);
    const storage: AssetStorage = {
      presignPost: () => ({ url: "", fields: {} }),
      head: async (key) => objects.has(key) ? { size: 4 } : null,
      read: async () => new Uint8Array(4),
      put: async (key) => { objects.add(key); },
      remove: async (key) => { objects.delete(key); },
      copy: async (source, destination) => { if (!objects.has(source)) throw new Error("missing source"); objects.add(destination); },
      presignGet: () => ({ url: "" }),
    };
    const wiki = createWikiActions(tx, () => new Date("2026-01-01T00:00:00Z"), storage);
    const parent = await wiki.createWikiPage.handler({ userId: alice.id }, { workspaceId: workspace.id, projectId: project.id, title: "Folder" });
    const page = await wiki.createWikiPage.handler({ userId: alice.id }, {
      workspaceId: workspace.id, projectId: project.id, parentId: parent.id, title: "Guide", content: doc("body"),
    });
    await wiki.createWikiPage.handler({ userId: alice.id }, { workspaceId: workspace.id, projectId: project.id, parentId: page.id, title: "Child" });
    await tx.insert(assets).values({
      workspaceId: workspace.id, projectId: project.id, ownerType: "wiki_page", ownerId: page.id, uploaderId: alice.id,
      storageKey: "source/image", filename: "image.png", contentType: "image/png", size: 4, status: "uploaded", uploadedAt: new Date(),
    });
    const [asset] = await tx.select().from(assets).where(eq(assets.ownerId, page.id));
    const content = { type: "doc", content: [{ type: "paragraph", content: [{ type: "assetImage", attrs: { assetId: asset!.id } }] }] };
    await tx.update(wikiPages).set({ content, ydocState: wikiYStateFromContent(content) }).where(eq(wikiPages.id, page.id));
    const duplicate = await wiki.duplicateWikiPage.handler({ userId: bob.id }, { pageId: page.id });
    expect(duplicate).toMatchObject({ title: "Guide (copy)", projectId: project.id, parentId: parent.id, ownerId: bob.id });
    expect(duplicate.content).not.toEqual(content);
    const findImage = (node: { type?: string; attrs?: Record<string, unknown>; content?: Array<never> }): Record<string, unknown> | null => {
      if (node.type === "assetImage") return node.attrs ?? null;
      for (const child of (node.content ?? []) as unknown as Array<{ type?: string; attrs?: Record<string, unknown>; content?: Array<never> }>) {
        const found = findImage(child);
        if (found) return found;
      }
      return null;
    };
    const copiedAssetId = findImage(duplicate.content as { type?: string; attrs?: Record<string, unknown>; content?: Array<never> })?.assetId;
    expect(typeof copiedAssetId).toBe("string");
    expect(await wiki.listWikiPageVersions.handler({ userId: bob.id }, { pageId: duplicate.id })).toEqual([]);
    expect((await wiki.listProjectWikiPages.handler({ userId: alice.id }, { projectId: project.id })).map(({ id }) => id)).toContain(duplicate.id);
    expect(await tx.select().from(wikiPages).where(eq(wikiPages.parentId, duplicate.id))).toEqual([]);
    const copiedAssets = await createAssetActions(tx, storage).listAssets.handler({ userId: bob.id }, { ownerType: "wiki_page", ownerId: duplicate.id });
    expect(copiedAssets).toHaveLength(1);
    expect(copiedAssets[0]!.id).toBe(copiedAssetId as string);
    expect(await wiki.deleteWikiPage.handler({ userId: alice.id }, { pageId: page.id })).toEqual({ deleted: 2 });
    expect(await createAssetActions(tx, storage).listAssets.handler({ userId: bob.id }, { ownerType: "wiki_page", ownerId: duplicate.id })).toHaveLength(1);
    const copiedRow = (await tx.select().from(assets).where(eq(assets.ownerId, duplicate.id)))[0]!;
    expect(copiedRow.storageKey).not.toBe("source/image");
    expect(await storage.head(copiedRow.storageKey)).toEqual({ size: 4 });
    const hidden = await wiki.createWikiPage.handler({ userId: alice.id }, { workspaceId: workspace.id, projectId: project.id, title: "Private", access: "private" });
    await expect(wiki.duplicateWikiPage.handler({ userId: bob.id }, { pageId: hidden.id })).rejects.toMatchObject({ status: 404 });
  });
});

test.concurrent("Wiki page access is read-only when its Project is archived", async () => {
  await withRollback(db, async (tx) => {
    const { workspace, alice, bob, wiki } = await setup(tx);
    const projects = createProjectActions(tx);
    const project = await projects.createProject.handler({ userId: alice.id }, {
      workspaceId: workspace.id, name: "Docs", key: "DOC", visibility: "public",
    });
    await projects.addProjectMember.handler({ userId: alice.id }, { projectId: project.id, userId: bob.id, role: "Member" });
    const page = await wiki.createWikiPage.handler({ userId: alice.id }, { workspaceId: workspace.id, projectId: project.id, title: "Guide" });

    expect(await wiki.getWikiPageAccess.handler({ userId: bob.id }, { pageId: page.id })).toEqual({ canRead: true, canWrite: true, locked: false });
    await projects.archiveProject.handler({ userId: alice.id }, { projectId: project.id });
    expect(await wiki.getWikiPageAccess.handler({ userId: bob.id }, { pageId: page.id })).toEqual({ canRead: true, canWrite: false, locked: false });
  });
});

test.concurrent("builds a page tree and moves a page, refusing cycles", async () => {
  await withRollback(db, async (tx) => {
    const { alice, wiki, create } = await setup(tx);
    const root = await create(alice.id, "Handbook");
    const child = await create(alice.id, "Onboarding", { parentId: root.id });
    const grandchild = await create(alice.id, "Day one", { parentId: child.id });
    expect(grandchild.parentId).toBe(child.id);
    const moved = await wiki.moveWikiPage.handler({ userId: alice.id }, { pageId: grandchild.id, parentId: root.id });
    expect(moved.parentId).toBe(root.id);
    expect((await failure(wiki.moveWikiPage.handler({ userId: alice.id }, { pageId: root.id, parentId: child.id })))?.status).toBe(400);
    expect((await failure(wiki.moveWikiPage.handler({ userId: alice.id }, { pageId: root.id, parentId: root.id })))?.status).toBe(400);
    const top = await wiki.moveWikiPage.handler({ userId: alice.id }, { pageId: grandchild.id, parentId: null });
    expect(top.parentId).toBeNull();
  });
});

test.concurrent("the stored sibling order is what the shared and project lists return", async () => {
  await withRollback(db, async (tx) => {
    const { workspace, alice, bob, wiki, create } = await setup(tx);
    const project = await createProjectActions(tx).createProject.handler({ userId: alice.id }, { workspaceId: workspace.id, name: "Docs", key: "DOC", visibility: "public" });
    const p1 = await create(alice.id, "Project one", { projectId: project.id });
    const p2 = await create(alice.id, "Project two", { projectId: project.id });
    const p3 = await create(alice.id, "Project three", { projectId: project.id });
    await wiki.moveWikiPage.handler({ userId: alice.id }, { pageId: p3.id, parentId: null, siblingId: p1.id, position: "before" });
    expect((await wiki.listProjectWikiPages.handler({ userId: alice.id }, { projectId: project.id })).map((row) => row.title)).toEqual(["Project three", "Project one", "Project two"]);
    await wiki.moveWikiPage.handler({ userId: alice.id }, { pageId: p1.id, parentId: null, siblingId: p2.id, position: "after" });
    expect((await wiki.listProjectWikiPages.handler({ userId: alice.id }, { projectId: project.id })).map((row) => row.title)).toEqual(["Project three", "Project two", "Project one"]);
    expect(p2.projectId).toBe(project.id);
    // Pages shared with Bob come back in the same stored order, whichever way they were moved.
    const first = await create(alice.id, "Shared first");
    const second = await create(alice.id, "Shared second");
    await wiki.shareWikiPage.handler({ userId: alice.id }, { pageId: first.id, userId: bob.id, role: "view" });
    await wiki.shareWikiPage.handler({ userId: alice.id }, { pageId: second.id, userId: bob.id, role: "view" });
    await wiki.moveWikiPage.handler({ userId: alice.id }, { pageId: second.id, parentId: null, siblingId: first.id, position: "before" });
    expect((await wiki.listSharedWikiPages.handler({ userId: bob.id }, { workspaceId: workspace.id })).map((row) => row.title)).toEqual(["Shared second", "Shared first"]);
  });
});

test("listWikiPages keeps the old page set and write permissions with a query count independent of page count", async () => {
  const queries: string[] = [];
  const loggedDb = drizzle(client, { schema, logger: { logQuery: (query) => queries.push(query) } }) as unknown as Database;
  await withRollback(loggedDb, async (tx) => {
    const { workspace, alice, bob, guest, wiki, create } = await setup(tx);
    const own = await create(bob.id, "Own page");
    const list = (userId: string, includeArchived = false) => wiki.listWikiPages.handler({ userId }, { workspaceId: workspace.id, archived: includeArchived });
    queries.length = 0;
    const onePage = await list(bob.id);
    const onePageQueryCount = queries.length;
    expect(onePage.map(({ id, canEdit }) => [id, canEdit])).toEqual([[own.id, true]]);

    const edit = await create(alice.id, "Edit share");
    const view = await create(alice.id, "View share");
    const comment = await create(alice.id, "Comment share");
    const locked = await create(bob.id, "Locked page");
    const archived = await create(bob.id, "Archived page");
    const privateCollection = await wiki.createCollection.handler({ userId: alice.id }, { workspaceId: workspace.id, name: "Private shelf", visibility: "private" });
    const collectionPage = await create(alice.id, "Collection member page", { collectionId: privateCollection.id });
    await wiki.shareCollection.handler({ userId: alice.id }, { collectionId: privateCollection.id, userId: bob.id });
    const pageSharedFromPrivateCollection = await create(alice.id, "Page share in private shelf", { collectionId: privateCollection.id });

    await wiki.shareWikiPage.handler({ userId: alice.id }, { pageId: edit.id, userId: bob.id, role: "edit" });
    await wiki.shareWikiPage.handler({ userId: alice.id }, { pageId: view.id, userId: bob.id, role: "view" });
    await wiki.shareWikiPage.handler({ userId: alice.id }, { pageId: comment.id, userId: bob.id, role: "comment" });
    await wiki.shareWikiPage.handler({ userId: alice.id }, { pageId: pageSharedFromPrivateCollection.id, userId: bob.id, role: "edit" });
    await wiki.shareWikiPage.handler({ userId: alice.id }, { pageId: edit.id, userId: guest.id, role: "edit" });
    await wiki.lockWikiPage.handler({ userId: bob.id }, { pageId: locked.id });
    await wiki.archiveWikiPage.handler({ userId: bob.id }, { pageId: archived.id });

    const morePages = await Promise.all(Array.from({ length: 8 }, (_, index) => create(alice.id, `Additional page ${index}`)));
    queries.length = 0;
    const pages = await list(bob.id);
    const manyPageQueryCount = queries.length;
    const expectedIds = [own.id, edit.id, view.id, comment.id, locked.id, collectionPage.id, pageSharedFromPrivateCollection.id, ...morePages.map(({ id }) => id)];
    expect(pages.map(({ id }) => id)).toEqual((await tx.select({ id: wikiPages.id, sortOrder: wikiPages.sortOrder, createdAt: wikiPages.createdAt }).from(wikiPages).where(inArray(wikiPages.id, expectedIds))).sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id)).map(({ id }) => id));
    expect(new Set(pages.map(({ id }) => id))).toEqual(new Set(expectedIds));
    expect(Object.fromEntries(pages.map(({ id, canEdit }) => [id, canEdit]))).toEqual({
      [own.id]: true,
      [edit.id]: true,
      [view.id]: false,
      [comment.id]: false,
      [locked.id]: true,
      [collectionPage.id]: true,
      [pageSharedFromPrivateCollection.id]: true,
      ...Object.fromEntries(morePages.map(({ id }) => [id, true])),
    });
    expect((await list(guest.id)).map(({ id, canEdit }) => [id, canEdit]).find(([id]) => id === edit.id)).toEqual([edit.id, true]);
    expect((await list(bob.id, true)).map(({ id, canEdit }) => [id, canEdit])).toContainEqual([archived.id, false]);
    expect(manyPageQueryCount).toBe(onePageQueryCount);
  });
});

test.concurrent("a page moved beside a sibling under a different parent lands in that parent's order", async () => {
  await withRollback(db, async (tx) => {
    const { workspace, alice, wiki, create } = await setup(tx);
    const move = (input: Record<string, unknown>) => wiki.moveWikiPage.handler({ userId: alice.id }, input as never);
    // Old parent holds two children with high orders, so a wrong list would give a visibly wrong number.
    const oldParent = await create(alice.id, "Old parent");
    const nested = await create(alice.id, "Nested", { parentId: oldParent.id });
    const other = await create(alice.id, "Other child", { parentId: oldParent.id });
    expect(other.id).not.toBe(nested.id);
    const x = await create(alice.id, "X");
    const y = await create(alice.id, "Y");
    const z = await create(alice.id, "Z");
    // Nested leaves its parent and goes between Y and Z at the top level.
    await move({ pageId: nested.id, parentId: null, siblingId: y.id, position: "after" });
    const top = (await wiki.listWikiPages.handler({ userId: alice.id }, { workspaceId: workspace.id })).filter((row) => row.parentId === null).map((row) => row.title);
    expect(top.filter((title) => ["X", "Y", "Nested", "Z"].includes(title))).toEqual(["X", "Y", "Nested", "Z"]);
    // And the other way: top-level Z goes before Other child inside the old parent.
    await move({ pageId: z.id, parentId: oldParent.id, siblingId: other.id, position: "before" });
    const inside = (await wiki.listWikiPages.handler({ userId: alice.id }, { workspaceId: workspace.id })).filter((row) => row.parentId === oldParent.id).map((row) => row.title);
    expect(inside).toEqual(["Z", "Other child"]);
    expect(x.id).not.toBe(y.id);
  });
});

test.concurrent("moves a page before or after a sibling with the position parameter, and every list keeps the order", async () => {
  await withRollback(db, async (tx) => {
    const { workspace, alice, bob, guest, wiki, create, titles } = await setup(tx);
    const a = await create(alice.id, "A");
    const b = await create(alice.id, "B");
    const c = await create(alice.id, "C");
    const move = (userId: string, input: Record<string, unknown>) => wiki.moveWikiPage.handler({ userId }, input as never);
    // Before the first sibling, after the last, and in the middle.
    await move(alice.id, { pageId: c.id, parentId: null, siblingId: a.id, position: "before" });
    expect(await titles(alice.id)).toEqual(["C", "A", "B"]);
    await move(alice.id, { pageId: a.id, parentId: null, siblingId: b.id, position: "after" });
    expect(await titles(alice.id)).toEqual(["C", "B", "A"]);
    await move(alice.id, { pageId: c.id, parentId: null, siblingId: a.id, position: "after" });
    expect(await titles(alice.id)).toEqual(["B", "A", "C"]);
    await move(alice.id, { pageId: b.id, parentId: null, siblingId: c.id, position: "after" });
    expect(await titles(alice.id)).toEqual(["A", "C", "B"]);
    // The order is stored, so another member and a fresh read see the same list.
    expect((await wiki.listWikiPages.handler({ userId: alice.id }, { workspaceId: workspace.id })).map((row) => row.title)).toEqual(["A", "C", "B"]);
    // Siblings under a parent: the position parameter places the page among that parent's children.
    const parent = await create(alice.id, "Parent");
    const first = await create(alice.id, "First", { parentId: parent.id });
    const second = await create(alice.id, "Second", { parentId: parent.id });
    const moved = await move(alice.id, { pageId: second.id, parentId: parent.id, siblingId: first.id, position: "before" });
    expect(moved.parentId).toBe(parent.id);
    expect((await wiki.listWikiPages.handler({ userId: alice.id }, { workspaceId: workspace.id })).filter((row) => row.parentId === parent.id).map((row) => row.title)).toEqual(["Second", "First"]);
    // A position needs a sibling, the sibling must share the new parent, and a page cannot sit beside itself.
    expect((await failure(move(alice.id, { pageId: b.id, parentId: null, position: "before" })))?.status).toBe(400);
    expect((await failure(move(alice.id, { pageId: b.id, parentId: null, siblingId: first.id, position: "after" })))?.status).toBe(400);
    expect((await failure(move(alice.id, { pageId: b.id, parentId: null, siblingId: b.id, position: "before" })))?.status).toBe(400);
    // A sibling in another Collection is refused; the move must use the Collection confirmation instead.
    const other = await wiki.createCollection.handler({ userId: alice.id }, { workspaceId: workspace.id, name: "Elsewhere" });
    const outside = await create(alice.id, "Outside", { collectionId: other.id });
    expect((await failure(move(alice.id, { pageId: b.id, parentId: null, siblingId: outside.id, position: "before" })))?.status).toBe(400);
    // Only people who can see and edit the page may move it: a private page of someone else is not found, and a Guest cannot edit.
    const secret = await create(alice.id, "Secret", { access: "private" });
    expect((await failure(move(bob.id, { pageId: secret.id, parentId: null, siblingId: a.id, position: "before" })))?.status).toBe(404);
    expect((await failure(move(guest.id, { pageId: b.id, parentId: null, siblingId: a.id, position: "before" })))?.status).toBe(403);
    expect(await titles(alice.id)).toContain("B");
  });
});

test.concurrent("private pages are visible only to the owner; public to every member", async () => {
  await withRollback(db, async (tx) => {
    const { alice, bob, admin, guest, wiki, create, titles } = await setup(tx);
    const open = await create(alice.id, "Open");
    const secret = await create(alice.id, "Draft", { access: "private" });
    expect(await titles(alice.id)).toEqual(["Open", "Draft"]);
    expect(await titles(bob.id)).toEqual(["Open"]);
    expect(await titles(admin.id)).toEqual(["Open"]);
    expect(await titles(guest.id)).toEqual(["Open"]);
    expect((await failure(wiki.getWikiPage.handler({ userId: bob.id }, { pageId: secret.id })))?.status).toBe(404);
    expect((await wiki.getWikiPage.handler({ userId: guest.id }, { pageId: open.id })).title).toBe("Open");
    expect((await failure(wiki.updateWikiPage.handler({ userId: guest.id }, { pageId: open.id, title: "x" })))?.status).toBe(403);
    expect((await failure(wiki.setWikiPageAccess.handler({ userId: bob.id }, { pageId: open.id, access: "private" })))?.status).toBe(403);
    await wiki.setWikiPageAccess.handler({ userId: alice.id }, { pageId: secret.id, access: "public" });
    expect(await titles(bob.id)).toEqual(["Open", "Draft"]);
  });
});

test.concurrent("Wiki page Shares grant view, comment, or edit access and can be revoked", async () => {
  await withRollback(db, async (tx) => {
    const { workspace, alice, bob, admin, guest, wiki, create, titles } = await setup(tx);
    const page = await create(alice.id, "Shared", { access: "private" });
    await wiki.shareWikiPage.handler({ userId: alice.id }, { pageId: page.id, userId: bob.id, role: "view" });
    expect((await wiki.getWikiPage.handler({ userId: bob.id }, { pageId: page.id })).canEdit).toBe(false);
    expect(await failure(wiki.updateWikiPage.handler({ userId: bob.id }, { pageId: page.id, title: "No" }))).toMatchObject({ status: 403 });
    expect(await wiki.listSharedWikiPages.handler({ userId: bob.id }, { workspaceId: workspace.id })).toMatchObject([{ id: page.id }]);
    await wiki.shareWikiPage.handler({ userId: alice.id }, { pageId: page.id, userId: bob.id, role: "comment" });
    expect((await wiki.getWikiPage.handler({ userId: bob.id }, { pageId: page.id })).canEdit).toBe(false);
    await wiki.shareWikiPage.handler({ userId: alice.id }, { pageId: page.id, userId: bob.id, role: "edit" });
    expect((await wiki.getWikiPage.handler({ userId: bob.id }, { pageId: page.id })).canEdit).toBe(true);
    expect((await wiki.updateWikiPage.handler({ userId: bob.id }, { pageId: page.id, title: "Edited" })).title).toBe("Edited");
    await wiki.revokeWikiPageShare.handler({ userId: alice.id }, { pageId: page.id, userId: bob.id });
    expect((await failure(wiki.getWikiPage.handler({ userId: bob.id }, { pageId: page.id })))?.status).toBe(404);
    expect(await titles(admin.id)).not.toContain("Edited");
    await wiki.shareWikiPage.handler({ userId: alice.id }, { pageId: page.id, userId: guest.id, role: "edit" });
    expect((await wiki.updateWikiPage.handler({ userId: guest.id }, { pageId: page.id, title: "Guest editor" })).title).toBe("Guest editor");
  });
});

test.concurrent("Wiki page Shares bypass private Collection visibility only for the shared page", async () => {
  await withRollback(db, async (tx) => {
    const { workspace, alice, bob, wiki, create, titles } = await setup(tx);
    const collection = await wiki.createCollection.handler({ userId: alice.id }, { workspaceId: workspace.id, name: "Private", visibility: "private" });
    const page = await create(alice.id, "Shared page", { collectionId: collection.id });
    const child = await create(alice.id, "Unshared child", { collectionId: collection.id, parentId: page.id });
    await wiki.shareWikiPage.handler({ userId: alice.id }, { pageId: page.id, userId: bob.id, role: "view" });
    expect((await wiki.getWikiPage.handler({ userId: bob.id }, { pageId: page.id })).title).toBe("Shared page");
    expect(await titles(bob.id)).toContain("Shared page");
    expect(await wiki.searchWikiPages.handler({ userId: bob.id }, { workspaceId: workspace.id, query: "Shared" })).toMatchObject([{ id: page.id }]);
    await expect(wiki.getWikiPage.handler({ userId: bob.id }, { pageId: child.id })).rejects.toMatchObject({ status: 404 });
    // Assets authorize through requireWikiPageAccess, which must honour the same share.
    expect((await requireWikiPageAccess(tx, bob.id, page.id, "read")).id).toBe(page.id);
    await expect(requireWikiPageAccess(tx, bob.id, child.id, "read")).rejects.toMatchObject({ status: 404 });
  });
});

test.concurrent("moving a child to another scope makes it a root and private Collections revoke publication", async () => {
  await withRollback(db, async (tx) => {
    const { workspace, alice, wiki, create } = await setup(tx);
    const shelf = await wiki.createCollection.handler({ userId: alice.id }, { workspaceId: workspace.id, name: "Shelf" });
    const source = await create(alice.id, "Source", { collectionId: shelf.id });
    const child = await create(alice.id, "Child", { parentId: source.id });
    const destination = await wiki.createCollection.handler({ userId: alice.id }, { workspaceId: workspace.id, name: "Private", visibility: "private" });
    const moved = await wiki.movePageScope.handler({ userId: alice.id }, { pageId: child.id, projectId: null, collectionId: destination.id });
    expect(moved).toBeDefined();
    expect((await wiki.listWikiPages.handler({ userId: alice.id }, { workspaceId: workspace.id })).map((page) => page.id)).toContain(child.id);
    expect((await wiki.getWikiPage.handler({ userId: alice.id }, { pageId: child.id })).parentId).toBeNull();
    const token = await wiki.publishWikiPage.handler({ userId: alice.id }, { pageId: source.id });
    await wiki.setCollectionVisibility.handler({ userId: alice.id }, { collectionId: (await tx.select().from(collections).where(eq(collections.id, source.collectionId!)))[0]!.id, visibility: "private" });
    await expect(wiki.publishWikiPage.handler({ userId: alice.id }, { pageId: source.id })).rejects.toMatchObject({ status: 400 });
    expect((await tx.select({ publishedTokenHash: wikiPages.publishedTokenHash }).from(wikiPages).where(eq(wikiPages.id, source.id)))[0]!.publishedTokenHash).toBeNull();
    expect(token.token).toBeTruthy();
  });
});

test.concurrent("Collection shares can be listed and revoked by owner", async () => {
  await withRollback(db, async (tx) => {
    const { workspace, alice, bob, wiki } = await setup(tx);
    const collection = await wiki.createCollection.handler({ userId: alice.id }, { workspaceId: workspace.id, name: "Private", visibility: "private" });
    await wiki.shareCollection.handler({ userId: alice.id }, { collectionId: collection.id, userId: bob.id });
    expect(await wiki.listCollectionMembers.handler({ userId: alice.id }, { collectionId: collection.id })).toMatchObject([{ userId: bob.id }]);
    expect(await wiki.revokeCollectionShare.handler({ userId: alice.id }, { collectionId: collection.id, userId: bob.id })).toEqual({ revoked: true });
    await expect(wiki.listCollectionMembers.handler({ userId: alice.id }, { collectionId: collection.id })).resolves.toEqual([]);
  });
});

test.concurrent("links work items to only readable pages and shares links through page mentions", async () => {
  await withRollback(db, async (tx) => {
    const { workspace, alice, bob, wiki, create } = await setup(tx);
    const projects = createProjectActions(tx);
    const project = await projects.createProject.handler({ userId: alice.id }, { workspaceId: workspace.id, name: "Docs", key: "DOC", visibility: "public" });
    await projects.addProjectMember.handler({ userId: alice.id }, { projectId: project.id, userId: bob.id, role: "Member" });
    const work = (await (await import("../src")).createWorkItemActions(tx).createWorkItem.handler({ userId: alice.id }, { projectId: project.id, title: "Write docs" }));
    const page = await create(alice.id, "Readable", { projectId: project.id, content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "mention", attrs: { id: `work-item:${work.id}`, label: "DOC-1" } }] }] } });
    const privatePage = await create(alice.id, "Secret", { projectId: project.id, access: "private" });
    const actions = createWikiActions(tx);
    expect(await actions.linkWorkItemPage.handler({ userId: alice.id }, { workItemId: work.id, pageId: page.id })).toMatchObject({ linked: true });
    expect(await tx.select().from(outlinks).where(eq(outlinks.sourceId, work.id))).toMatchObject([{ sourceKind: "work-item", targetKind: "page", targetId: page.id }]);
    await expect(actions.linkWorkItemPage.handler({ userId: bob.id }, { workItemId: work.id, pageId: privatePage.id })).rejects.toMatchObject({ status: 404 });
    expect((await actions.listWorkItemPages.handler({ userId: bob.id }, { workItemId: work.id })).map((row) => row.id)).toEqual([page.id]);
    expect((await actions.listWikiPageWorkItems.handler({ userId: bob.id }, { pageId: page.id })).map((row) => row.id)).toEqual([work.id]);
    await wiki.movePageScope.handler({ userId: alice.id }, { pageId: page.id, projectId: null });
    expect(await actions.listWorkItemPages.handler({ userId: bob.id }, { workItemId: work.id })).toEqual([]);
  });
});

test.concurrent("Wiki page Comments keep page Outlinks current as their text changes", async () => {
  await withRollback(db, async (tx) => {
    const { alice, create } = await setup(tx);
    const source = await create(alice.id, "Source");
    const target = await create(alice.id, "Target");
    const actions = createWikiActions(tx);
    const comment = await actions.createWikiPageComment.handler({ userId: alice.id }, { pageId: source.id, anchor: "anchor", bodyMarkdown: `[[Target|wiki:${target.id}]]` });
    expect(await tx.select().from(outlinks).where(eq(outlinks.sourceId, source.id))).toMatchObject([
      { sourceKind: "wiki", sourceId: source.id, targetKind: "wiki", targetId: target.id },
    ]);
    await actions.updateWikiPageComment.handler({ userId: alice.id }, { commentId: comment.id, bodyMarkdown: "Reference removed" });
    expect(await tx.select().from(outlinks).where(eq(outlinks.sourceId, source.id))).toEqual([]);
  });
});

test.concurrent("stores Tiptap JSON with a plain-text column", async () => {
  await withRollback(db, async (tx) => {
    const { alice, wiki, create } = await setup(tx);
    const page = await create(alice.id, "Notes", { content: doc("hello world") });
    expect(page.content).toEqual(doc("hello world"));
    expect(page.contentText).toBe("hello world");
    const saved = await wiki.updateWikiPage.handler({ userId: alice.id }, { pageId: page.id, content: doc("changed text") });
    expect(saved.contentText).toBe("changed text");
    expect((await wiki.getWikiPage.handler({ userId: alice.id }, { pageId: page.id })).content).toEqual(doc("changed text"));
  });
});

test.concurrent("workspace Admins save and delete templates, and members create owned copies in either scope", async () => {
  await withRollback(db, async (tx) => {
    const { workspace, alice, bob, admin, guest, wiki, create } = await setup(tx);
    const source = await create(alice.id, "Starter", { content: doc("template body") });
    const actions = createWikiActions(tx);
    await expect(actions.createWikiPageTemplate.handler({ userId: alice.id }, { pageId: source.id })).rejects.toMatchObject({ status: 403 });
    const template = await actions.createWikiPageTemplate.handler({ userId: admin.id }, { pageId: source.id });
    expect(template).toMatchObject({ title: "Starter", content: doc("template body"), createdBy: admin.id });
    expect(await actions.listWikiPageTemplates.handler({ userId: guest.id }, { workspaceId: workspace.id })).toEqual([]);
    const wikiCopy = await actions.createWikiPage.handler({ userId: bob.id }, { workspaceId: workspace.id, templateId: template.id });
    expect(wikiCopy).toMatchObject({ title: "Starter", content: doc("template body"), contentText: "template body", ownerId: bob.id, projectId: null });
    const project = await createProjectActions(tx).createProject.handler({ userId: alice.id }, { workspaceId: workspace.id, name: "Docs", key: "DOC", visibility: "public" });
    await createProjectActions(tx).addProjectMember.handler({ userId: alice.id }, { projectId: project.id, userId: bob.id, role: "Member" });
    const pageCopy = await actions.createWikiPage.handler({ userId: bob.id }, { workspaceId: workspace.id, projectId: project.id, templateId: template.id });
    expect(pageCopy).toMatchObject({ title: "Starter", content: doc("template body"), ownerId: bob.id, projectId: project.id });
    await expect(actions.deleteWikiPageTemplate.handler({ userId: bob.id }, { templateId: template.id })).rejects.toMatchObject({ status: 403 });
    expect(await actions.deleteWikiPageTemplate.handler({ userId: admin.id }, { templateId: template.id })).toEqual({ deleted: true });
  });
});

test.concurrent("autosave versions on a cadence and restore brings back an old version", async () => {
  await withRollback(db, async (tx) => {
    const { alice, wiki, create, advance } = await setup(tx);
    const page = await create(alice.id, "Plan", { content: doc("v1") });
    const save = (text: string) => wiki.updateWikiPage.handler({ userId: alice.id }, { pageId: page.id, content: doc(text) });
    const count = async () => (await wiki.listWikiPageVersions.handler({ userId: alice.id }, { pageId: page.id })).length;
    expect(await count()).toBe(1);
    expect(versionIntervalMs).toBe(5 * 60_000);
    advance(10_000); await save("v2");
    advance(10_000); await save("v2 more");
    expect(await count()).toBe(1);
    advance(versionIntervalMs); await save("v3");
    expect(await count()).toBe(2);
    const versions = await wiki.listWikiPageVersions.handler({ userId: alice.id }, { pageId: page.id });
    const first = versions[versions.length - 1]!;
    advance(1000);
    const restored = await wiki.restoreWikiPageVersion.handler({ userId: alice.id }, { pageId: page.id, versionId: first.id });
    expect(restored.contentText).toBe("v1");
    const state = (await wiki.getWikiPage.handler({ userId: alice.id }, { pageId: page.id }));
    expect(wikiContentFromYState((await tx.select().from(wikiPages).where(eq(wikiPages.id, page.id)))[0]!.ydocState!)).toEqual(doc("v1"));
    expect(state.contentText).toBe("v1");
    // The page was at "v3" before the restore and a version of "v3" already exists, so the undo point is that version, not a copy of it.
    expect(await count()).toBe(2);
    expect((await tx.select().from(wikiPageVersions).where(eq(wikiPageVersions.pageId, page.id))).some((version) => version.contentText === "v3")).toBe(true);
    expect((await failure(wiki.restoreWikiPageVersion.handler({ userId: alice.id }, { pageId: page.id, versionId: crypto.randomUUID() })))?.status).toBe(404);
  });
});

test.concurrent("multiple members can save the same page without a single-editor lock", async () => {
  await withRollback(db, async (transaction) => {
    const { workspace, alice, bob } = await setup(transaction);
    const wiki = createWikiActions(transaction);
    const page = await wiki.createWikiPage.handler({ userId: alice.id }, { workspaceId: workspace.id, title: "Shared" });
    const saved = await Promise.all([
      wiki.updateWikiPage.handler({ userId: alice.id }, { pageId: page.id, title: "Alice" }),
      wiki.updateWikiPage.handler({ userId: bob.id }, { pageId: page.id, content: doc("Bob") }),
    ]);
    expect(saved).toHaveLength(2);
    expect((await wiki.getWikiPage.handler({ userId: alice.id }, { pageId: page.id })).contentText).toBe("Bob");
  });
});

test.concurrent("wiki full-text search has an index available to PostgreSQL", async () => {
  await withRollback(db, async (tx) => {
    await tx.execute(sql`set local enable_seqscan = off`);
    const plan = await tx.execute<{ "QUERY PLAN": string }>(sql`explain (costs off)
      select id from wiki_pages
      where to_tsvector('english', title || ' ' || content_text) @@ plainto_tsquery('english', 'release plan')`);
    expect(plan.map((row) => row["QUERY PLAN"]).join("\n")).toContain("wiki_pages_fts_idx");
  });
});

test.concurrent("soft delete hides the page and its subtree; only owner or Admin may delete", async () => {
  await withRollback(db, async (tx) => {
    const { alice, bob, admin, wiki, create, titles } = await setup(tx);
    const root = await create(alice.id, "Root");
    await create(alice.id, "Leaf", { parentId: root.id });
    const other = await create(alice.id, "Other");
    expect((await failure(wiki.deleteWikiPage.handler({ userId: bob.id }, { pageId: root.id })))?.status).toBe(403);
    expect(await wiki.deleteWikiPage.handler({ userId: alice.id }, { pageId: root.id })).toEqual({ deleted: 2 });
    expect(await titles(alice.id)).toEqual(["Other"]);
    expect((await failure(wiki.getWikiPage.handler({ userId: alice.id }, { pageId: root.id })))?.status).toBe(404);
    expect(await wiki.deleteWikiPage.handler({ userId: admin.id }, { pageId: other.id })).toEqual({ deleted: 1 });
  });
});

test.concurrent("search finds permitted wiki pages in English and Thai, never private ones of others or deleted ones", async () => {
  await withRollback(db, async (tx) => {
    const { workspace, alice, bob, wiki, create } = await setup(tx);
    await create(alice.id, "Deploy guide", { content: doc("run the release script") });
    await create(alice.id, "คู่มือใหม่", { content: doc("ขั้นตอนการเริ่มงาน") });
    await create(alice.id, "Secret plan", { access: "private", content: doc("release secrets") });
    const gone = await create(alice.id, "Old release", { content: doc("release") });
    const archived = await create(alice.id, "Archived release", { content: doc("release") });
    await wiki.archiveWikiPage.handler({ userId: alice.id }, { pageId: archived.id });
    await wiki.deleteWikiPage.handler({ userId: alice.id }, { pageId: gone.id });
    const find = (userId: string, query: string) => wiki.searchWikiPages.handler({ userId }, { workspaceId: workspace.id, query }).then((rows) => rows.map((row) => row.title));
    expect(await find(bob.id, "release")).toEqual(["Deploy guide"]);
    expect(await find(alice.id, "release")).toEqual(["Deploy guide", "Secret plan"]);
    expect(await find(bob.id, "เริ่มงาน")).toEqual(["คู่มือใหม่"]);
    expect(await find(bob.id, "deploy")).toEqual(["Deploy guide"]);
  });
});

test.concurrent("workspace Admins can inspect and move a Page without source project membership", async () => {
  await withRollback(db, async (tx) => {
    const { workspace, alice, admin, wiki, create } = await setup(tx);
    const project = await createProjectActions(tx).createProject.handler({ userId: alice.id }, { workspaceId: workspace.id, name: "Docs", key: "DOC", visibility: "public" });
    const page = await create(alice.id, "Project page", { projectId: project.id });
    expect(await wiki.getPageMoveImpact.handler({ userId: admin.id }, { pageId: page.id, projectId: null })).toMatchObject({ pageCount: 1 });
    await wiki.movePageScope.handler({ userId: admin.id }, { pageId: page.id, projectId: null });
    expect((await wiki.getWikiPage.handler({ userId: admin.id }, { pageId: page.id })).projectId).toBeNull();
  });
});

test.concurrent("wiki writes record Activity with the source and chat id, including AI edits", async () => {
  await withRollback(db, async (tx) => {
    const { workspace, alice, wiki } = await setup(tx);
    const chatId = crypto.randomUUID();
    const page = await wiki.createWikiPage.handler({ userId: alice.id, source: "ai", chatId }, { workspaceId: workspace.id, title: "Plan" });
    await wiki.updateWikiPage.handler({ userId: alice.id, source: "ai", chatId }, { pageId: page.id, content: doc("one") });
    await wiki.updateWikiPage.handler({ userId: alice.id, source: "ai", chatId }, { pageId: page.id, content: doc("two") });
    await wiki.setWikiPageAccess.handler({ userId: alice.id }, { pageId: page.id, access: "private" });
    await wiki.deleteWikiPage.handler({ userId: alice.id }, { pageId: page.id }).catch(() => null);
    const rows = await tx.execute<{ field: string; source: string; chat_id: string | null; actor_id: string }>(
      sql`select field, source, chat_id, actor_id from activities where entity_type = 'wiki_page' and entity_id = ${page.id} order by seq`);
    const list = [...rows];
    expect(list.map((row) => row.field)).toEqual(["created", "content", "content", "access", "deleted"]);
    expect(list.slice(0, 3).every((row) => row.source === "ai" && row.chat_id === chatId && row.actor_id === alice.id)).toBe(true);
    expect(list[3]!.source).toBe("ui");
  });
});

test.concurrent("list_wiki_page_activities is readable by anyone who can read the page, not by outsiders", async () => {
  await withRollback(db, async (tx) => {
    const { workspace, alice, bob, wiki } = await setup(tx);
    const open = await wiki.createWikiPage.handler({ userId: alice.id }, { workspaceId: workspace.id, title: "Open" });
    const secret = await wiki.createWikiPage.handler({ userId: alice.id }, { workspaceId: workspace.id, title: "Mine", access: "private" });
    expect((await wiki.listWikiPageActivities.handler({ userId: bob.id }, { pageId: open.id })).map((row) => row.field)).toEqual(["created"]);
    expect((await failure(wiki.listWikiPageActivities.handler({ userId: bob.id }, { pageId: secret.id })))?.status).toBe(404);
  });
});

test.concurrent("deleting a page never deletes another user's private page under it", async () => {
  await withRollback(db, async (tx) => {
    const { alice, bob, admin, wiki, create, titles } = await setup(tx);
    const parent = await create(alice.id, "Parent");
    await create(bob.id, "Bob's draft", { parentId: parent.id, access: "private" });
    expect((await failure(wiki.deleteWikiPage.handler({ userId: alice.id }, { pageId: parent.id })))?.status).toBe(409);
    expect((await failure(wiki.deleteWikiPage.handler({ userId: admin.id }, { pageId: parent.id })))?.status).toBe(409);
    expect((await titles(bob.id)).sort()).toEqual(["Bob's draft", "Parent"]);
    const lonely = await create(alice.id, "Lonely");
    expect((await wiki.deleteWikiPage.handler({ userId: alice.id }, { pageId: lonely.id })).deleted).toBe(1);
  });
});

test.concurrent("a Member cannot move another user's page under their own page and then delete it", async () => {
  await withRollback(db, async (tx) => {
    const { alice, bob, admin, wiki, create, titles } = await setup(tx);
    const bobs = await create(bob.id, "Bob's public page");
    const mine = await create(alice.id, "Alice's page");
    const hideout = await create(alice.id, "Alice's hideout", { access: "private" });
    // Moving someone else's page under a private parent would hide it from its owner.
    expect((await failure(wiki.moveWikiPage.handler({ userId: alice.id }, { pageId: bobs.id, parentId: hideout.id })))?.status).toBe(403);
    // Under a public parent it is allowed, but the parent can no longer be deleted by a non-Admin.
    await wiki.moveWikiPage.handler({ userId: alice.id }, { pageId: bobs.id, parentId: mine.id });
    expect((await failure(wiki.deleteWikiPage.handler({ userId: alice.id }, { pageId: mine.id })))?.status).toBe(403);
    expect(await titles(bob.id)).toContain("Bob's public page");
    // Her own page may go under her private parent.
    const own = await create(alice.id, "Own child");
    expect((await wiki.moveWikiPage.handler({ userId: alice.id }, { pageId: own.id, parentId: hideout.id })).parentId).toBe(hideout.id);
    expect(await wiki.deleteWikiPage.handler({ userId: admin.id }, { pageId: mine.id })).toEqual({ deleted: 2 });
  });
});

test.concurrent("project Page permissions hide the list, detail, activity, search and private Pages from outsiders", async () => {
  await withRollback(db, async (tx) => {
    const { workspace, alice, bob, admin, wiki } = await setup(tx);
    const project = await createProjectActions(tx).createProject.handler({ userId: alice.id }, {
      workspaceId: workspace.id, name: "Docs", key: "DOC", visibility: "public",
    });
    const shared = await wiki.createWikiPage.handler({ userId: alice.id }, { workspaceId: workspace.id, projectId: project.id, title: "Release plan" });
    const secret = await wiki.createWikiPage.handler({ userId: alice.id }, { workspaceId: workspace.id, projectId: project.id, title: "Private draft", access: "private" });
    const hidden = async (action: Promise<unknown>) => expect((await failure(action))?.status).toBe(404);
    expect((await wiki.listProjectWikiPages.handler({ userId: alice.id }, { projectId: project.id })).map((page) => page.id)).toEqual([shared.id, secret.id]);
    for (const outsider of [bob, admin]) {
      await hidden(wiki.listProjectWikiPages.handler({ userId: outsider.id }, { projectId: project.id }));
      await hidden(wiki.getWikiPage.handler({ userId: outsider.id }, { pageId: shared.id }));
      await hidden(wiki.getWikiPage.handler({ userId: outsider.id }, { pageId: secret.id }));
      await hidden(wiki.listWikiPageActivities.handler({ userId: outsider.id }, { pageId: shared.id }));
      expect(await wiki.searchWikiPages.handler({ userId: outsider.id }, { workspaceId: workspace.id, query: "Release plan" })).toEqual([]);
    }
    expect((await wiki.searchWikiPages.handler({ userId: alice.id }, { workspaceId: workspace.id, query: "Release plan" })).map((page) => page.id)).toContain(shared.id);
    expect((await wiki.listWikiPages.handler({ userId: alice.id }, { workspaceId: workspace.id })).map((page) => page.id)).toEqual([]);
  });
});

test.concurrent("moving a Wiki page into and out of a project moves its subtree", async () => {
  await withRollback(db, async (tx) => {
    const { workspace, alice, bob, wiki, create } = await setup(tx);
    const project = await createProjectActions(tx).createProject.handler({ userId: alice.id }, {
      workspaceId: workspace.id, name: "Docs", key: "DOC", visibility: "public",
    });
    const root = await create(alice.id, "Roadmap");
    const child = await create(alice.id, "Quarter one", { parentId: root.id });
    expect((await wiki.movePageScope.handler({ userId: alice.id }, { pageId: root.id, projectId: project.id })).projectId).toBe(project.id);
    expect((await wiki.listProjectWikiPages.handler({ userId: alice.id }, { projectId: project.id })).map((page) => page.id)).toContain(root.id);
    expect((await wiki.listWikiPages.handler({ userId: alice.id }, { workspaceId: workspace.id })).map((page) => page.id)).not.toContain(root.id);
    expect((await failure(wiki.getWikiPage.handler({ userId: bob.id }, { pageId: child.id })))?.status).toBe(404);
    expect((await wiki.movePageScope.handler({ userId: alice.id }, { pageId: root.id, projectId: null })).projectId).toBeNull();
    expect((await wiki.getWikiPage.handler({ userId: bob.id }, { pageId: child.id })).title).toBe("Quarter one");
    expect((await wiki.listWikiPages.handler({ userId: alice.id }, { workspaceId: workspace.id })).map((page) => page.id)).toContain(root.id);
  });
});

test.concurrent("previews the exact data removed by a move and moves the subtree into a selected Collection", async () => {
  await withRollback(db, async (tx) => {
    const { workspace, alice, bob, wiki, create } = await setup(tx);
    const projects = createProjectActions(tx);
    const project = await projects.createProject.handler({ userId: alice.id }, { workspaceId: workspace.id, name: "Docs", key: "DOC", visibility: "public" });
    const item = await (await import("../src")).createWorkItemActions(tx).createWorkItem.handler({ userId: alice.id }, { projectId: project.id, title: "Write docs" });
    const root = await create(alice.id, "Handbook", { projectId: project.id });
    const child = await create(alice.id, "Setup", { projectId: project.id, parentId: root.id });
    await wiki.linkWorkItemPage.handler({ userId: alice.id }, { workItemId: item.id, pageId: child.id });
    const collection = await wiki.createCollection.handler({ userId: alice.id }, { workspaceId: workspace.id, name: "Guides" });
    const otherProject = await projects.createProject.handler({ userId: bob.id }, { workspaceId: workspace.id, name: "Other", key: "OTH", visibility: "public" });
    expect((await failure(wiki.movePageScope.handler({ userId: alice.id }, { pageId: root.id, projectId: otherProject.id })))?.status).toBe(403);
    const impact = await wiki.getPageMoveImpact.handler({ userId: alice.id }, { pageId: root.id, projectId: null, collectionId: collection.id });
    expect(impact).toEqual({ pageCount: 2, shareCount: 0, publishedLink: false, workItemLinkCount: 1 });
    expect((await wiki.listWikiPageWorkItems.handler({ userId: alice.id }, { pageId: child.id })).map(({ id }) => id)).toEqual([item.id]);
    await wiki.movePageScope.handler({ userId: alice.id }, { pageId: root.id, projectId: null, collectionId: collection.id });
    expect((await wiki.getWikiPage.handler({ userId: alice.id }, { pageId: root.id })).collectionId).toBe(collection.id);
    expect((await wiki.getWikiPage.handler({ userId: alice.id }, { pageId: child.id })).collectionId).toBe(collection.id);
    expect(await wiki.listWikiPageWorkItems.handler({ userId: alice.id }, { pageId: child.id })).toEqual([]);
  });
});

test.concurrent("moving a shared Wiki page into a project reports and removes its Shares", async () => {
  await withRollback(db, async (tx) => {
    const { workspace, alice, bob, wiki, create } = await setup(tx);
    const project = await createProjectActions(tx).createProject.handler({ userId: alice.id }, { workspaceId: workspace.id, name: "Docs", key: "DOC", visibility: "public" });
    await createProjectActions(tx).addProjectMember.handler({ userId: alice.id }, { projectId: project.id, userId: bob.id, role: "Member" });
    const page = await create(alice.id, "Shared note");
    await wiki.shareWikiPage.handler({ userId: alice.id }, { pageId: page.id, userId: bob.id, role: "view" });
    expect(await wiki.getPageMoveImpact.handler({ userId: alice.id }, { pageId: page.id, projectId: project.id })).toMatchObject({ shareCount: 1 });
    await wiki.movePageScope.handler({ userId: alice.id }, { pageId: page.id, projectId: project.id });
    await wiki.movePageScope.handler({ userId: alice.id }, { pageId: page.id, projectId: null });
    expect(await wiki.listWikiPageShares.handler({ userId: alice.id }, { pageId: page.id })).toEqual([]);
  });
});

test.concurrent("favorites are private to each user and inaccessible pages disappear", async () => {
  await withRollback(db, async (tx) => {
    const { workspace, alice, bob, wiki } = await setup(tx);
    const project = await createProjectActions(tx).createProject.handler({ userId: alice.id }, { workspaceId: workspace.id, name: "Docs", key: "DOC", visibility: "public" });
    await createProjectActions(tx).addProjectMember.handler({ userId: alice.id }, { projectId: project.id, userId: bob.id, role: "Member" });
    const page = await wiki.createWikiPage.handler({ userId: alice.id }, { workspaceId: workspace.id, projectId: project.id, title: "Shared guide" });
    const wikiPage = await wiki.createWikiPage.handler({ userId: alice.id }, { workspaceId: workspace.id, title: "Wiki guide" });
    await wiki.favoriteWikiPage.handler({ userId: alice.id }, { pageId: page.id, favorite: true });
    await wiki.favoriteWikiPage.handler({ userId: alice.id }, { pageId: wikiPage.id, favorite: true });
    expect((await wiki.listFavoriteWikiPages.handler({ userId: alice.id }, { workspaceId: workspace.id })).map(({ id }) => id)).toEqual([page.id, wikiPage.id]);
    expect(await wiki.listFavoriteWikiPages.handler({ userId: bob.id }, { workspaceId: workspace.id })).toEqual([]);
    await wiki.favoriteWikiPage.handler({ userId: bob.id }, { pageId: page.id, favorite: true });
    expect((await wiki.listFavoriteWikiPages.handler({ userId: bob.id }, { workspaceId: workspace.id })).map(({ id }) => id)).toEqual([page.id]);
    await tx.delete(projectMembers).where(eq(projectMembers.userId, bob.id));
    expect(await wiki.listFavoriteWikiPages.handler({ userId: bob.id }, { workspaceId: workspace.id })).toEqual([]);
  });
});

test.concurrent("favorites from other projects remain visible when one project's Pages feature is disabled", async () => {
  await withRollback(db, async (tx) => {
    const { workspace, alice, wiki } = await setup(tx);
    const projectActions = createProjectActions(tx);
    const disabled = await projectActions.createProject.handler({ userId: alice.id }, { workspaceId: workspace.id, name: "Disabled", key: "OFF", visibility: "public" });
    const enabled = await projectActions.createProject.handler({ userId: alice.id }, { workspaceId: workspace.id, name: "Enabled", key: "ON", visibility: "public" });
    const hiddenPage = await wiki.createWikiPage.handler({ userId: alice.id }, { workspaceId: workspace.id, projectId: disabled.id, title: "Hidden favorite" });
    const visiblePage = await wiki.createWikiPage.handler({ userId: alice.id }, { workspaceId: workspace.id, projectId: enabled.id, title: "Visible favorite" });
    await wiki.favoriteWikiPage.handler({ userId: alice.id }, { pageId: hiddenPage.id, favorite: true });
    await wiki.favoriteWikiPage.handler({ userId: alice.id }, { pageId: visiblePage.id, favorite: true });
    await tx.update(projects).set({ pagesEnabled: false }).where(eq(projects.id, disabled.id));
    expect((await wiki.listFavoriteWikiPages.handler({ userId: alice.id }, { workspaceId: workspace.id })).map(({ id }) => id)).toEqual([visiblePage.id]);
  });
});

test.concurrent("wiki search excludes pages in projects with Pages disabled", async () => {
  await withRollback(db, async (tx) => {
    const { workspace, alice, wiki } = await setup(tx);
    const project = await createProjectActions(tx).createProject.handler({ userId: alice.id }, { workspaceId: workspace.id, name: "Hidden", key: "HID", visibility: "public" });
    const hidden = await wiki.createWikiPage.handler({ userId: alice.id }, { workspaceId: workspace.id, projectId: project.id, title: "Secret searchable phrase" });
    const visible = await wiki.createWikiPage.handler({ userId: alice.id }, { workspaceId: workspace.id, title: "Secret searchable phrase in workspace" });
    await tx.update(projects).set({ pagesEnabled: false }).where(eq(projects.id, project.id));
    expect((await wiki.searchWikiPages.handler({ userId: alice.id }, { workspaceId: workspace.id, query: "Secret searchable phrase" })).map(({ id }) => id)).toEqual([visible.id]);
    expect(hidden.id).not.toBe(visible.id);
  });
});

test.concurrent("restoring the same version twice adds no duplicate version", async () => {
  await withRollback(db, async (tx) => {
    const { alice, wiki, create, advance } = await setup(tx);
    const page = await create(alice.id, "Plan", { content: doc("v1") });
    await wiki.updateWikiPage.handler({ userId: alice.id }, { pageId: page.id, content: doc("v2") });
    advance(versionIntervalMs);
    await wiki.updateWikiPage.handler({ userId: alice.id }, { pageId: page.id, content: doc("v3") });
    const versions = await wiki.listWikiPageVersions.handler({ userId: alice.id }, { pageId: page.id });
    const first = versions[versions.length - 1]!;
    advance(1000);
    await wiki.restoreWikiPageVersion.handler({ userId: alice.id }, { pageId: page.id, versionId: first.id });
    advance(1000);
    await wiki.restoreWikiPageVersion.handler({ userId: alice.id }, { pageId: page.id, versionId: first.id });
    const stored = await tx.select().from(wikiPageVersions).where(eq(wikiPageVersions.pageId, page.id));
    const keys = stored.map((row) => `${row.title}\u0000${JSON.stringify(row.content)}`);
    // Only v1 (create) and v3 are kept; neither restore added a copy.
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
    // The kept version the page now equals takes the time of the second restore, so the autosave throttle counts it.
    expect(stored.find((row) => row.id === first.id)!.createdAt.getTime()).toBeGreaterThan(new Date(first.createdAt).getTime());
    // A title-only change is a real change and still adds a version.
    advance(versionIntervalMs);
    await wiki.updateWikiPage.handler({ userId: alice.id }, { pageId: page.id, title: "Plan renamed" });
    expect(await tx.select().from(wikiPageVersions).where(eq(wikiPageVersions.pageId, page.id))).toHaveLength(3);
  });
});

test.concurrent("archives only a page, hides it from normal lists, and restores it unchanged with owner or Admin permissions", async () => {
  await withRollback(db, async (tx) => {
    const { workspace, alice, bob, admin, guest, wiki, create } = await setup(tx);
    const projects = createProjectActions(tx);
    const project = await projects.createProject.handler({ userId: alice.id }, { workspaceId: workspace.id, name: "Docs", key: "DOC", visibility: "public" });
    await projects.addProjectMember.handler({ userId: alice.id }, { projectId: project.id, userId: bob.id, role: "Member" });
    const wikiPage = await create(alice.id, "Workspace page");
    const parent = await create(alice.id, "Parent", { projectId: project.id, content: doc("keep me") });
    const child = await create(bob.id, "Child", { projectId: project.id, parentId: parent.id });
    const status = (userId: string, action: "archiveWikiPage" | "unarchiveWikiPage") => wiki[action].handler({ userId }, { pageId: parent.id }).then(() => 200, (error: ActionError) => error.status);

    await wiki.archiveWikiPage.handler({ userId: alice.id }, { pageId: wikiPage.id });
    expect((await wiki.listWikiPages.handler({ userId: alice.id }, { workspaceId: workspace.id })).map((page) => page.id)).not.toContain(wikiPage.id);
    expect((await wiki.listWikiPages.handler({ userId: alice.id }, { workspaceId: workspace.id, archived: true })).map((page) => page.id)).toContain(wikiPage.id);
    expect(await status(guest.id, "archiveWikiPage")).toBe(403);
    expect(await status(bob.id, "archiveWikiPage")).toBe(403);
    await expect(wiki.archiveWikiPage.handler({ userId: alice.id }, { pageId: parent.id })).resolves.toMatchObject({ archived: true });
    expect((await wiki.listProjectWikiPages.handler({ userId: alice.id }, { projectId: project.id })).map((page) => page.id)).toEqual([child.id]);
    expect((await wiki.listProjectWikiPages.handler({ userId: alice.id }, { projectId: project.id, archived: true })).map((page) => page.id)).toEqual([parent.id]);
    expect((await wiki.getWikiPage.handler({ userId: alice.id }, { pageId: child.id })).parentId).toBe(parent.id);
    await expect(wiki.updateWikiPage.handler({ userId: alice.id }, { pageId: parent.id, title: "Changed" })).rejects.toMatchObject({ status: 400 });
    await expect(wiki.unarchiveWikiPage.handler({ userId: bob.id }, { pageId: parent.id })).rejects.toMatchObject({ status: 403 });
    await wiki.unarchiveWikiPage.handler({ userId: admin.id }, { pageId: parent.id });
    expect(await wiki.getWikiPage.handler({ userId: alice.id }, { pageId: parent.id })).toMatchObject({ title: "Parent", contentText: "keep me" });
    expect(new Set((await wiki.listProjectWikiPages.handler({ userId: alice.id }, { projectId: project.id })).map((page) => page.id))).toEqual(new Set([parent.id, child.id]));
  });
});

test.concurrent("Collections organize Wiki pages and private Collections hide from unshared members", async () => {
  await withRollback(db, async (tx) => {
    const { workspace, alice, bob, admin, wiki } = await setup(tx);
    const created = await wiki.createCollection.handler({ userId: alice.id }, { workspaceId: workspace.id, name: "Engineering", visibility: "private" });
    const page = await wiki.createWikiPage.handler({ userId: alice.id }, { workspaceId: workspace.id, title: "Runbook", collectionId: created.id });
    const otherCollection = await wiki.createCollection.handler({ userId: alice.id }, { workspaceId: workspace.id, name: "Product" });
    const otherPage = await wiki.createWikiPage.handler({ userId: alice.id }, { workspaceId: workspace.id, title: "Roadmap", collectionId: otherCollection.id });
    expect((await failure(wiki.moveWikiPage.handler({ userId: alice.id }, { pageId: page.id, parentId: otherPage.id })))?.status).toBe(400);
    expect(page.collectionId).toBe(created.id);
    expect((await wiki.listWikiPages.handler({ userId: alice.id }, { workspaceId: workspace.id })).map((row) => row.title)).toContain("Runbook");
    expect((await wiki.listWikiPages.handler({ userId: bob.id }, { workspaceId: workspace.id })).map((row) => row.title)).not.toContain("Runbook");
    expect((await failure(wiki.getWikiPage.handler({ userId: admin.id }, { pageId: page.id })))?.status).toBe(404);
    expect(await wiki.searchWikiPages.handler({ userId: bob.id }, { workspaceId: workspace.id, query: "Runbook" })).toEqual([]);
    expect((await failure(wiki.renameCollection.handler({ userId: bob.id }, { collectionId: created.id, name: "Hijacked" })))?.status).toBe(403);
    await wiki.shareCollection.handler({ userId: alice.id }, { collectionId: created.id, userId: bob.id });
    expect((await wiki.listWikiPages.handler({ userId: bob.id }, { workspaceId: workspace.id })).map((row) => row.title)).toContain("Runbook");
    expect((await wiki.listCollections.handler({ userId: bob.id }, { workspaceId: workspace.id })).map((row) => row.name)).toContain("Engineering");
    expect(await wiki.renameCollection.handler({ userId: alice.id }, { collectionId: created.id, name: "Operations" })).toEqual({ id: created.id, name: "Operations" });
    await wiki.setCollectionVisibility.handler({ userId: alice.id }, { collectionId: created.id, visibility: "public" });
    expect((await wiki.getWikiPage.handler({ userId: admin.id }, { pageId: page.id })).title).toBe("Runbook");
    expect((await failure(wiki.deleteCollection.handler({ userId: alice.id }, { collectionId: created.id })))?.status).toBe(400);
    await wiki.deleteWikiPage.handler({ userId: alice.id }, { pageId: page.id });
    expect(await wiki.deleteCollection.handler({ userId: alice.id }, { collectionId: created.id })).toEqual({ deleted: true });
    await wiki.createWikiPage.handler({ userId: alice.id }, { workspaceId: workspace.id, title: "Loose page" });
    const defaultCollection = (await wiki.listCollections.handler({ userId: alice.id }, { workspaceId: workspace.id })).find((row) => row.isDefault);
    expect(defaultCollection).toBeDefined();
    expect((await failure(wiki.deleteCollection.handler({ userId: alice.id }, { collectionId: defaultCollection!.id })))?.status).toBe(400);
  });
});

test.concurrent("Wiki comment threads require comment access, support replies and resolution, and can be restored", async () => {
  await withRollback(db, async (tx) => {
    const { workspace, alice, bob, wiki } = await setup(tx);
    const page = await wiki.createWikiPage.handler({ userId: alice.id }, { workspaceId: workspace.id, title: "Review" });
    await wiki.shareWikiPage.handler({ userId: alice.id }, { pageId: page.id, userId: bob.id, role: "view" });
    const anchor = Buffer.from("relative-yjs-position").toString("base64");
    await expect(wiki.createWikiPageComment.handler({ userId: bob.id }, { pageId: page.id, body: doc("note"), anchor })).rejects.toMatchObject({ status: 403 });
    await wiki.shareWikiPage.handler({ userId: alice.id }, { pageId: page.id, userId: bob.id, role: "comment" });
    const thread = await wiki.createWikiPageComment.handler({ userId: bob.id }, { pageId: page.id, body: doc("note"), anchor });
    expect(thread.bodyMarkdown).toBe("note");
    expect(thread.body).toMatchObject({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "note" }] }] });
    await wiki.replyWikiPageComment.handler({ userId: alice.id }, { commentId: thread.id, body: doc("reply") });
    await wiki.resolveWikiPageComment.handler({ userId: bob.id }, { commentId: thread.id, resolved: true });
    expect(await wiki.listWikiPageComments.handler({ userId: alice.id }, { pageId: page.id })).toEqual([]);
    expect(await wiki.listWikiPageComments.handler({ userId: alice.id }, { pageId: page.id, includeResolved: true })).toMatchObject([{ id: thread.id, resolved: true, anchor, replies: [{ bodyText: "reply" }] }]);
    await wiki.resolveWikiPageComment.handler({ userId: bob.id }, { commentId: thread.id, resolved: false });
    expect(await wiki.updateWikiPageComment.handler({ userId: bob.id }, { commentId: thread.id, body: doc("edited by author") })).toMatchObject({ bodyText: "edited by author" });
    await expect(wiki.updateWikiPageComment.handler({ userId: alice.id }, { commentId: thread.id, body: doc("changed") })).rejects.toMatchObject({ status: 403 });
    await wiki.shareWikiPage.handler({ userId: alice.id }, { pageId: page.id, userId: bob.id, role: "view" });
    await expect(wiki.updateWikiPageComment.handler({ userId: bob.id }, { commentId: thread.id, body: doc("no longer allowed") })).rejects.toMatchObject({ status: 403 });
    expect((await wiki.listWikiPageComments.handler({ userId: alice.id }, { pageId: page.id }))[0]?.anchor).toBe(anchor);
  });
});

test.concurrent("Project Wiki comments require project write access for every mutation", async () => {
  await withRollback(db, async (tx) => {
    const { workspace, alice, bob, guest, wiki } = await setup(tx);
    const projects = createProjectActions(tx);
    const project = await projects.createProject.handler({ userId: alice.id }, { workspaceId: workspace.id, name: "Docs", key: "DOC", visibility: "public" });
    await projects.addProjectMember.handler({ userId: alice.id }, { projectId: project.id, userId: bob.id, role: "Member" });
    await projects.addProjectMember.handler({ userId: alice.id }, { projectId: project.id, userId: guest.id, role: "Member" });
    const page = await wiki.createWikiPage.handler({ userId: alice.id }, { workspaceId: workspace.id, projectId: project.id, title: "Review" });
    const thread = await wiki.createWikiPageComment.handler({ userId: bob.id }, { pageId: page.id, body: doc("member comment"), anchor: "anchor" });

    await expect(wiki.createWikiPageComment.handler({ userId: guest.id }, { pageId: page.id, body: doc("guest comment"), anchor: "anchor" })).rejects.toMatchObject({ status: 403 });
    await expect(wiki.replyWikiPageComment.handler({ userId: guest.id }, { commentId: thread.id, body: doc("guest reply") })).rejects.toMatchObject({ status: 403 });
    await expect(wiki.updateWikiPageComment.handler({ userId: guest.id }, { commentId: thread.id, body: doc("guest edit") })).rejects.toMatchObject({ status: 403 });
    await expect(wiki.resolveWikiPageComment.handler({ userId: guest.id }, { commentId: thread.id, resolved: true })).rejects.toMatchObject({ status: 403 });
    await expect(wiki.replyWikiPageComment.handler({ userId: bob.id }, { commentId: thread.id, body: doc("member reply") })).resolves.toBeDefined();
    await expect(wiki.updateWikiPageComment.handler({ userId: bob.id }, { commentId: thread.id, body: doc("member edit") })).resolves.toMatchObject({ bodyText: "member edit" });
    await expect(wiki.resolveWikiPageComment.handler({ userId: bob.id }, { commentId: thread.id, resolved: true })).resolves.toEqual({ resolved: true });
  });
});

test.concurrent("listing Wiki comment replies uses a fixed number of queries and keeps thread order", async () => {
  await withRollback(db, async (tx) => {
    const { workspace, alice, wiki } = await setup(tx);
    const page = await wiki.createWikiPage.handler({ userId: alice.id }, { workspaceId: workspace.id, title: "Query count" });
    const addThread = async (body: string) => wiki.createWikiPageComment.handler({ userId: alice.id }, { pageId: page.id, body: doc(body), anchor: body });
    const first = await addThread("first");
    await wiki.replyWikiPageComment.handler({ userId: alice.id }, { commentId: first.id, body: doc("first reply") });

    let selectCalls = 0;
    const countingDb = new Proxy(tx, {
      get(target, property) {
        if (property === "select") return (...args: Parameters<Database["select"]>) => {
          selectCalls++;
          return target.select(...args);
        };
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const listing = createWikiActions(countingDb);
    selectCalls = 0;
    const oneThread = await listing.listWikiPageComments.handler({ userId: alice.id }, { pageId: page.id });
    const oneThreadSelects = selectCalls;

    const second = await addThread("second");
    await wiki.replyWikiPageComment.handler({ userId: alice.id }, { commentId: second.id, body: doc("second reply") });
    const third = await addThread("third");
    await wiki.replyWikiPageComment.handler({ userId: alice.id }, { commentId: third.id, body: doc("third reply") });
    selectCalls = 0;
    const threeThreads = await listing.listWikiPageComments.handler({ userId: alice.id }, { pageId: page.id });

    expect(threeThreads).toHaveLength(3);
    expect(threeThreads.map((thread) => thread.bodyText)).toEqual(["first", "second", "third"]);
    expect(threeThreads.map((thread) => thread.replies.map((reply) => reply.bodyText))).toEqual([["first reply"], ["second reply"], ["third reply"]]);
    expect(threeThreads.map((thread) => thread.anchor)).toEqual(["first", "second", "third"]);
    expect(selectCalls).toBe(oneThreadSelects);
    expect(oneThread).toMatchObject([{ bodyText: "first", anchor: "first", replies: [{ bodyText: "first reply" }] }]);
  });
});

test.concurrent("a Member cannot hide, rename or share the default Collection", async () => {
  await withRollback(db, async (tx) => {
    const { workspace, alice, bob, admin, wiki, create, titles } = await setup(tx);
    const page = await create(alice.id, "First page");
    const defaultCollectionId = page.collectionId!;
    await expect(wiki.setCollectionVisibility.handler({ userId: alice.id }, { collectionId: defaultCollectionId, visibility: "private" })).rejects.toMatchObject({ status: 403 });
    await expect(wiki.renameCollection.handler({ userId: alice.id }, { collectionId: defaultCollectionId, name: "Mine" })).rejects.toMatchObject({ status: 403 });
    await expect(wiki.shareCollection.handler({ userId: alice.id }, { collectionId: defaultCollectionId, userId: bob.id })).rejects.toMatchObject({ status: 403 });
    await expect(wiki.setCollectionVisibility.handler({ userId: admin.id }, { collectionId: defaultCollectionId, visibility: "private" })).rejects.toMatchObject({ status: 400 });
    expect(await titles(bob.id)).toContain("First page");
    expect(workspace.id).toBeTruthy();
  });
});

test.concurrent("a page sharee cannot duplicate into a private Collection they do not belong to", async () => {
  await withRollback(db, async (tx) => {
    const { workspace, alice, bob, wiki, create } = await setup(tx);
    const collection = await wiki.createCollection.handler({ userId: alice.id }, { workspaceId: workspace.id, name: "Private", visibility: "private" });
    const page = await create(alice.id, "Shared", { collectionId: collection.id });
    await wiki.shareWikiPage.handler({ userId: alice.id }, { pageId: page.id, userId: bob.id, role: "edit" });
    await expect(wiki.duplicateWikiPage.handler({ userId: bob.id }, { pageId: page.id })).rejects.toMatchObject({ status: 403 });
    expect((await wiki.duplicateWikiPage.handler({ userId: alice.id }, { pageId: page.id })).title).toBe("Shared (copy)");
  });
});

test.concurrent("moving a page scope is rejected while any descendant is locked", async () => {
  await withRollback(db, async (tx) => {
    const { alice, wiki, create } = await setup(tx);
    const parent = await create(alice.id, "Parent");
    const child = await create(alice.id, "Child", { parentId: parent.id });
    await wiki.lockWikiPage.handler({ userId: alice.id }, { pageId: child.id });
    const error = await failure(wiki.movePageScope.handler({ userId: alice.id }, { pageId: parent.id, projectId: null }));
    expect(error?.status).toBe(409);
    expect(error?.message).toContain("locked");
  });
});

test("every Wiki action is registered for REST, MCP and AI", () => {
  const registered = new Set(createActionList(db).map((action) => action.name));
  const missing = (Object.values(createWikiActions(db)) as unknown[]).filter((action): action is { name: string } => typeof action === "object" && action !== null && "handler" in action).map((action) => action.name).filter((name) => !registered.has(name));
  expect(missing).toEqual([]);
});

test.concurrent("moving a page tree is refused while it holds private pages of other people", async () => {
  await withRollback(db, async (tx) => {
    const { workspace, alice, bob, wiki, create } = await setup(tx);
    const root = await create(alice.id, "Root");
    await create(bob.id, "Bob private", { parentId: root.id, access: "private" });
    const shelf = await wiki.createCollection.handler({ userId: alice.id }, { workspaceId: workspace.id, name: "Shelf" });
    await expect(wiki.movePageScope.handler({ userId: alice.id }, { pageId: root.id, projectId: null, collectionId: shelf.id })).rejects.toMatchObject({ status: 409 });
  });
});
