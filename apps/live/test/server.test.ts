import { afterAll, expect, test } from "bun:test";
import { createDatabase } from "@weft/db";
import { withRollback, createMemberFactory, createWorkspaceFactory } from "../../../packages/db/src/test-helpers";
import { createWikiActions } from "../../../packages/actions/src";
import { createSignalBus } from "../../../packages/actions/src";
import { eq } from "drizzle-orm";
import { jobs, projectMembers, wikiPages } from "@weft/db";
import * as Y from "yjs";
import { createLiveServer, migrateExistingWikiDocuments } from "../src/server";
import { createHocuspocusProvider } from "./test-provider";
import { publishChange } from "../../api/src/events";

const { client, db } = createDatabase();
afterAll(async () => client.end());

test.concurrent("live page sessions converge, persist across server restart, and enforce read-only roles", async () => {
  await withRollback(db, async (transaction) => {
    const workspace = await createWorkspaceFactory(transaction);
    const owner = await createMemberFactory(transaction, workspace.id, "Admin");
    const writer = await createMemberFactory(transaction, workspace.id, "Member");
    const viewer = await createMemberFactory(transaction, workspace.id, "Guest");
    const page = await createWikiActions(transaction).createWikiPage.handler({ userId: owner.id }, { workspaceId: workspace.id, title: "Live", content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "start" }] }] } });
    const server = createLiveServer({ db: transaction, authenticate: async (token) => token === owner.id ? owner.id : token === viewer.id ? viewer.id : token === writer.id ? writer.id : null });
    await server.listen();
    const first = createHocuspocusProvider(server.url, page.id, owner.id);
    const second = createHocuspocusProvider(server.url, page.id, writer.id);
    const readOnly = createHocuspocusProvider(server.url, page.id, viewer.id);
    try {
      await Promise.all([first.synced, second.synced, readOnly.synced]);
      const paragraph = () => first.doc.getXmlFragment("default").get(0) as Y.XmlElement;
      first.doc.transact(() => (paragraph().get(0) as Y.XmlText).insert(5, " online"));
      await second.waitFor(() => (second.doc.getXmlFragment("default").get(0) as Y.XmlElement).toJSON().includes("online"));
      const offlineDoc = new Y.Doc();
      Y.applyUpdate(offlineDoc, Y.encodeStateAsUpdate(second.doc));
      second.destroy();
      first.doc.transact(() => (paragraph().get(0) as Y.XmlText).insert(12, "!"));
      const offlineParagraph = offlineDoc.getXmlFragment("default").get(0) as Y.XmlElement;
      offlineDoc.transact(() => (offlineParagraph.get(0) as Y.XmlText).insert(5, " offline"));
      const reconnected = createHocuspocusProvider(server.url, page.id, writer.id, offlineDoc);
      await reconnected.synced;
      await first.waitFor(() => (paragraph().get(0) as Y.XmlElement).toJSON().includes("offline"));
      expect((paragraph().get(0) as Y.XmlText).toString()).toContain("offline");
      expect((paragraph().get(0) as Y.XmlText).toString()).toContain("!");
      const guestParagraph = readOnly.doc.getXmlFragment("default").get(0) as Y.XmlElement;
      guestParagraph.get(0);
      readOnly.doc.transact(() => ((readOnly.doc.getXmlFragment("default").get(0) as Y.XmlElement).get(0) as Y.XmlText).insert(0, "denied "));
      await Bun.sleep(200);
      expect((paragraph().get(0) as Y.XmlText).toString()).not.toContain("denied");
    } finally {
      first.destroy(); second.destroy(); readOnly.destroy(); await server.destroy();
    }
    const restarted = createLiveServer({ db: transaction, authenticate: async (token) => token === owner.id ? owner.id : null });
    await restarted.listen();
    const afterRestart = createHocuspocusProvider(restarted.url, page.id, owner.id);
    try {
      await afterRestart.synced;
      expect(((afterRestart.doc.getXmlFragment("default").get(0) as Y.XmlElement).get(0) as Y.XmlText).toString()).toContain("offline");
      const [persisted] = await transaction.select().from(wikiPages).where(eq(wikiPages.id, page.id));
      expect(persisted?.contentText).toContain("offline");
      const history = await createWikiActions(transaction).listWikiPageVersions.handler({ userId: owner.id }, { pageId: page.id });
      expect(history).toHaveLength(1);
      const { wikiPageVersions } = await import("@weft/db");
      const [savedVersion] = await transaction.select().from(wikiPageVersions).where(eq(wikiPageVersions.id, history[0]!.id));
      expect(savedVersion?.ydocState).toBeInstanceOf(Uint8Array);
      expect(await createWikiActions(transaction).searchWikiPages.handler({ userId: owner.id }, { workspaceId: workspace.id, query: "offline" })).toHaveLength(1);
    } finally { afterRestart.destroy(); await restarted.destroy(); }
  });
});

test.concurrent("live sessions enforce Share roles and disconnect the member when a Share is revoked", async () => {
  await withRollback(db, async (transaction) => {
    const workspace = await createWorkspaceFactory(transaction);
    const owner = await createMemberFactory(transaction, workspace.id, "Admin");
    const viewer = await createMemberFactory(transaction, workspace.id, "Member");
    const editor = await createMemberFactory(transaction, workspace.id, "Member");
    const wiki = createWikiActions(transaction);
    const page = await wiki.createWikiPage.handler({ userId: owner.id }, { workspaceId: workspace.id, title: "Shared live", access: "private", content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "start" }] }] } });
    await wiki.shareWikiPage.handler({ userId: owner.id }, { pageId: page.id, userId: viewer.id, role: "view" });
    await wiki.shareWikiPage.handler({ userId: owner.id }, { pageId: page.id, userId: editor.id, role: "edit" });
    const bus = createSignalBus(Bun.env.DATABASE_URL);
    const server = createLiveServer({ db: transaction, bus, authenticate: async (token) => [owner.id, viewer.id, editor.id].includes(token) ? token : null });
    await server.listen();
    const ownerSession = createHocuspocusProvider(server.url, page.id, owner.id);
    const viewSession = createHocuspocusProvider(server.url, page.id, viewer.id);
    const editSession = createHocuspocusProvider(server.url, page.id, editor.id);
    try {
      await Promise.all([ownerSession.synced, viewSession.synced, editSession.synced]);
      const paragraph = (session: typeof ownerSession) => session.doc.getXmlFragment("default").get(0) as Y.XmlElement;
      editSession.doc.transact(() => (paragraph(editSession).get(0) as Y.XmlText).insert(5, " editable"));
      await ownerSession.waitFor(() => (paragraph(ownerSession).get(0) as Y.XmlText).toString().includes("editable"));
      viewSession.doc.transact(() => (paragraph(viewSession).get(0) as Y.XmlText).insert(0, "denied "));
      await Bun.sleep(200);
      expect((paragraph(ownerSession).get(0) as Y.XmlText).toString()).not.toContain("denied");

      await wiki.revokeWikiPageShare.handler({ userId: owner.id }, { pageId: page.id, userId: viewer.id });
      await bus.publish({ type: "revoke", workspaceId: workspace.id, pageId: page.id, userId: viewer.id });
      viewSession.doc.transact(() => (paragraph(viewSession).get(0) as Y.XmlText).insert(0, "revoked "));
      await Bun.sleep(300);
      const [persisted] = await transaction.select().from(wikiPages).where(eq(wikiPages.id, page.id));
      expect(persisted?.contentText).not.toContain("revoked");
      expect(persisted?.contentText).toContain("editable");
    } finally {
      ownerSession.destroy(); viewSession.destroy(); editSession.destroy(); await server.destroy(); await bus.close();
    }
  });
});

test.concurrent("live access is refreshed before writes and archived pages connect read-only", async () => {
  await withRollback(db, async (transaction) => {
    const workspace = await createWorkspaceFactory(transaction);
    const owner = await createMemberFactory(transaction, workspace.id, "Admin");
    const editor = await createMemberFactory(transaction, workspace.id, "Member");
    const wiki = createWikiActions(transaction);
    const page = await wiki.createWikiPage.handler({ userId: owner.id }, { workspaceId: workspace.id, title: "Permission refresh", access: "private", content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "start" }] }] } });
    await wiki.shareWikiPage.handler({ userId: owner.id }, { pageId: page.id, userId: editor.id, role: "edit" });
    const server = createLiveServer({ db: transaction, authenticate: async (token) => token === owner.id || token === editor.id ? token : null });
    await server.listen();
    const editorSession = createHocuspocusProvider(server.url, page.id, editor.id);
    try {
      await editorSession.synced;
      await wiki.shareWikiPage.handler({ userId: owner.id }, { pageId: page.id, userId: editor.id, role: "view" });
      editorSession.doc.transact(() => ((editorSession.doc.getXmlFragment("default").get(0) as Y.XmlElement).get(0) as Y.XmlText).insert(0, "denied "));
      await Bun.sleep(350);
      const [persisted] = await transaction.select().from(wikiPages).where(eq(wikiPages.id, page.id));
      expect(persisted?.contentText).not.toContain("denied");
    } finally { editorSession.destroy(); await server.destroy(); }

    const archived = await wiki.createWikiPage.handler({ userId: owner.id }, { workspaceId: workspace.id, title: "Archived", content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "archived" }] }] } });
    await wiki.archiveWikiPage.handler({ userId: owner.id }, { pageId: archived.id });
    const archivedServer = createLiveServer({ db: transaction, authenticate: async (token) => token === owner.id ? owner.id : null });
    await archivedServer.listen();
    const archivedSession = createHocuspocusProvider(archivedServer.url, archived.id, owner.id);
    try {
      await archivedSession.synced;
      archivedSession.doc.transact(() => ((archivedSession.doc.getXmlFragment("default").get(0) as Y.XmlElement).get(0) as Y.XmlText).insert(0, "denied "));
      await Bun.sleep(250);
      const [persisted] = await transaction.select().from(wikiPages).where(eq(wikiPages.id, archived.id));
      expect(persisted?.contentText).not.toContain("denied");
    } finally { archivedSession.destroy(); await archivedServer.destroy(); }
  });
});

test.concurrent("a user without page access cannot connect to the live document", async () => {
  await withRollback(db, async (transaction) => {
    const workspace = await createWorkspaceFactory(transaction);
    const owner = await createMemberFactory(transaction, workspace.id, "Admin");
    const outsider = await createMemberFactory(transaction, workspace.id, "Member");
    const page = await createWikiActions(transaction).createWikiPage.handler({ userId: owner.id }, { workspaceId: workspace.id, title: "Private", access: "private" });
    const server = createLiveServer({ db: transaction, authenticate: async (token) => token === outsider.id ? outsider.id : null });
    await server.listen();
    const session = createHocuspocusProvider(server.url, page.id, outsider.id);
    try { await expect(session.synced).rejects.toThrow(); }
    finally { session.destroy(); await server.destroy(); }
  });
});

test.concurrent("removing a project member closes their live page connection", async () => {
  await withRollback(db, async (transaction) => {
    const workspace = await createWorkspaceFactory(transaction);
    const owner = await createMemberFactory(transaction, workspace.id, "Admin");
    const member = await createMemberFactory(transaction, workspace.id, "Member");
    const { createProjectActions } = await import("../../../packages/actions/src/projects");
    const projectRow = await createProjectActions(transaction).createProject.handler({ userId: owner.id }, { workspaceId: workspace.id, name: "Live project", key: `LP${Math.floor(Math.random() * 100000)}`, visibility: "private" });
    await transaction.insert(projectMembers).values({ workspaceId: workspace.id, projectId: projectRow.id, userId: member.id, role: "Member" });
    const page = await createWikiActions(transaction).createWikiPage.handler({ userId: owner.id }, { workspaceId: workspace.id, projectId: projectRow.id, title: "Member page", content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "start" }] }] } });
    const server = createLiveServer({ db: transaction, authenticate: async (token) => [owner.id, member.id].includes(token) ? token : null });
    await server.listen();
    const session = createHocuspocusProvider(server.url, page.id, member.id);
    try {
      await session.synced;
      await transaction.delete(projectMembers).where(eq(projectMembers.projectId, projectRow.id)).then(() => undefined);
      session.doc.transact(() => ((session.doc.getXmlFragment("default").get(0) as Y.XmlElement).get(0) as Y.XmlText).insert(0, "denied "));
      await Promise.race([session.closed, Bun.sleep(2_000).then(() => { throw new Error("connection did not close after access was revoked"); })]);
      const [persisted] = await transaction.select().from(wikiPages).where(eq(wikiPages.id, page.id));
      expect(persisted?.contentText).not.toContain("denied");
    } finally { session.destroy(); await server.destroy(); }
  });
});

test.concurrent("legacy inline image Wiki pages migrate into displayable block images in durable Yjs state", async () => {
  await withRollback(db, async (transaction) => {
    const workspace = await createWorkspaceFactory(transaction);
    const owner = await createMemberFactory(transaction, workspace.id, "Admin");
    const wiki = createWikiActions(transaction);
    const page = await wiki.createWikiPage.handler({ userId: owner.id }, { workspaceId: workspace.id, title: "Legacy", content: { type: "doc", content: [{ type: "paragraph", content: [
      { type: "text", text: "migrate me " }, { type: "assetImage", attrs: { assetId: "legacy-asset" } }, { type: "text", text: "after" },
    ] }] } });
    await transaction.update(wikiPages).set({ ydocState: null }).where(eq(wikiPages.id, page.id));
    const versions = await wiki.listWikiPageVersions.handler({ userId: owner.id }, { pageId: page.id });
    const { wikiPageVersions } = await import("@weft/db");
    await transaction.update(wikiPageVersions).set({ ydocState: null }).where(eq(wikiPageVersions.id, versions[0]!.id));
    expect(await migrateExistingWikiDocuments(transaction)).toEqual({ pages: 1, versions: 1 });
    const [migrated] = await transaction.select().from(wikiPages).where(eq(wikiPages.id, page.id));
    const [version] = await transaction.select().from(wikiPageVersions).where(eq(wikiPageVersions.id, versions[0]!.id));
    expect(migrated?.ydocState).toBeInstanceOf(Uint8Array);
    expect(migrated?.contentText).toBe("migrate me \nafter");
    expect(migrated?.content).toMatchObject({ content: [
      { type: "paragraph", content: [{ type: "text", text: "migrate me " }] },
      { type: "assetImage", attrs: { assetId: "legacy-asset", width: null, alignment: "center" } },
      { type: "paragraph", content: [{ type: "text", text: "after" }] },
    ] });
    expect(version?.ydocState).toBeInstanceOf(Uint8Array);
    expect(await wiki.searchWikiPages.handler({ userId: owner.id }, { workspaceId: workspace.id, query: "migrate me" })).toHaveLength(1);
  });
});

test.concurrent("an AI page write is applied to editors already connected to the live document", async () => {
  await withRollback(db, async (transaction) => {
    const workspace = await createWorkspaceFactory(transaction);
    const owner = await createMemberFactory(transaction, workspace.id, "Admin");
    const wiki = createWikiActions(transaction);
    const page = await wiki.createWikiPage.handler({ userId: owner.id }, { workspaceId: workspace.id, title: "Live AI", content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "before" }] }] } });
    const bus = createSignalBus(Bun.env.DATABASE_URL);
    const server = createLiveServer({ db: transaction, bus, authenticate: async (token) => token === owner.id ? owner.id : null });
    await server.listen();
    const editor = createHocuspocusProvider(server.url, page.id, owner.id);
    try {
      await editor.synced;
      await wiki.updateWikiPage.handler({ userId: owner.id, source: "ai" }, { pageId: page.id, content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "after confirmation" }] }] } });
      await publishChange(transaction, bus, { pageId: page.id }, { pageId: page.id });
      await editor.waitFor(() => editor.doc.getXmlFragment("default").toJSON().includes("after confirmation"));
      expect(editor.doc.getXmlFragment("default").toJSON()).toContain("after confirmation");
    } finally { editor.destroy(); await server.destroy(); await bus.close(); }
  });
});

test.concurrent("live edits still persist after the page title is renamed during a session", async () => {
  await withRollback(db, async (transaction) => {
    const workspace = await createWorkspaceFactory(transaction);
    const owner = await createMemberFactory(transaction, workspace.id, "Admin");
    const wiki = createWikiActions(transaction);
    const page = await wiki.createWikiPage.handler({ userId: owner.id }, { workspaceId: workspace.id, title: "Before", content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "start" }] }] } });
    const server = createLiveServer({ db: transaction, authenticate: async (token) => token === owner.id ? owner.id : null });
    await server.listen();
    const session = createHocuspocusProvider(server.url, page.id, owner.id);
    try {
      await session.synced;
      await Bun.sleep(1_100);
      await wiki.updateWikiPage.handler({ userId: owner.id }, { pageId: page.id, title: "After" });
      (session.doc.getXmlFragment("default").get(0) as Y.XmlElement).get(0);
      session.doc.transact(() => ((session.doc.getXmlFragment("default").get(0) as Y.XmlElement).get(0) as Y.XmlText).insert(5, " kept"));
      await Bun.sleep(2_600);
      const [persisted] = await transaction.select().from(wikiPages).where(eq(wikiPages.id, page.id));
      expect(persisted?.title).toBe("After");
      expect(persisted?.contentText).toContain("kept");
    } finally { session.destroy(); await server.destroy(); }
  });
});

test.concurrent("a member mention typed in a live session queues one notification for a reader", async () => {
  await withRollback(db, async (transaction) => {
    const workspace = await createWorkspaceFactory(transaction);
    const owner = await createMemberFactory(transaction, workspace.id, "Admin");
    const reader = await createMemberFactory(transaction, workspace.id, "Member");
    const wiki = createWikiActions(transaction);
    const page = await wiki.createWikiPage.handler({ userId: owner.id }, { workspaceId: workspace.id, title: "Mentions", content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "hello " }] }] } });
    const server = createLiveServer({ db: transaction, authenticate: async (token) => token === owner.id ? owner.id : null });
    await server.listen();
    const session = createHocuspocusProvider(server.url, page.id, owner.id);
    try {
      await session.synced;
      const mention = new Y.XmlElement("mention");
      mention.setAttribute("id", reader.id);
      mention.setAttribute("label", "Reader");
      session.doc.transact(() => (session.doc.getXmlFragment("default").get(0) as Y.XmlElement).insert(1, [mention]));
      await Bun.sleep(2_600);
      const queued = await transaction.select().from(jobs).where(eq(jobs.type, "notify"));
      const mentions = queued.filter((job) => JSON.stringify(job.payload).includes(page.id) && JSON.stringify(job.payload).includes(reader.id));
      expect(mentions.length).toBe(1);
    } finally { session.destroy(); await server.destroy(); }
  });
});

test.concurrent("a mention the page cannot notify does not discard the live save or crash the server", async () => {
  await withRollback(db, async (transaction) => {
    const workspace = await createWorkspaceFactory(transaction);
    const owner = await createMemberFactory(transaction, workspace.id, "Admin");
    const outsider = await createMemberFactory(transaction, workspace.id, "Member");
    const wiki = createWikiActions(transaction);
    const page = await wiki.createWikiPage.handler({ userId: owner.id }, { workspaceId: workspace.id, title: "Private", access: "private", content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "hello " }] }] } });
    const server = createLiveServer({ db: transaction, authenticate: async (token) => token === owner.id ? owner.id : null });
    await server.listen();
    const session = createHocuspocusProvider(server.url, page.id, owner.id);
    const failures: unknown[] = [];
    const onRejection = (reason: unknown) => failures.push(reason);
    process.on("unhandledRejection", onRejection);
    try {
      await session.synced;
      const mention = new Y.XmlElement("mention");
      mention.setAttribute("id", outsider.id);
      mention.setAttribute("label", "Outsider");
      session.doc.transact(() => (session.doc.getXmlFragment("default").get(0) as Y.XmlElement).insert(1, [mention]));
      await Bun.sleep(2_600);
      const [stored] = await transaction.select({ content: wikiPages.content }).from(wikiPages).where(eq(wikiPages.id, page.id));
      expect(JSON.stringify(stored!.content)).toContain("mention");
      expect(failures).toEqual([]);
    } finally { process.off("unhandledRejection", onRejection); session.destroy(); await server.destroy(); }
  });
});

test.concurrent("a legacy version outside the editor schema is skipped instead of aborting the migration", async () => {
  await withRollback(db, async (transaction) => {
    const workspace = await createWorkspaceFactory(transaction);
    const owner = await createMemberFactory(transaction, workspace.id, "Admin");
    const wiki = createWikiActions(transaction);
    const page = await wiki.createWikiPage.handler({ userId: owner.id }, { workspaceId: workspace.id, title: "Legacy" });
    const versions = await wiki.listWikiPageVersions.handler({ userId: owner.id }, { pageId: page.id });
    const { wikiPageVersions } = await import("@weft/db");
    await transaction.update(wikiPageVersions).set({ ydocState: null, content: { type: "doc", content: [{ type: "unknownNode" }] } }).where(eq(wikiPageVersions.id, versions[0]!.id));
    expect(await migrateExistingWikiDocuments(transaction)).toMatchObject({ versions: 0 });
  });
});
