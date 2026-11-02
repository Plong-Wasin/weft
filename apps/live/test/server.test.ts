import { afterAll, expect, test } from "bun:test";
import { createDatabase } from "@weft/db";
import { withRollback, createMemberFactory, createWorkspaceFactory } from "../../../packages/db/src/test-helpers";
import { createWikiActions } from "../../../packages/actions/src";
import { createSignalBus } from "../../../packages/actions/src";
import { eq } from "drizzle-orm";
import { wikiPages } from "@weft/db";
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

test.concurrent("legacy page and version JSON migrate into durable Yjs state", async () => {
  await withRollback(db, async (transaction) => {
    const workspace = await createWorkspaceFactory(transaction);
    const owner = await createMemberFactory(transaction, workspace.id, "Admin");
    const wiki = createWikiActions(transaction);
    const page = await wiki.createWikiPage.handler({ userId: owner.id }, { workspaceId: workspace.id, title: "Legacy", content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "migrate me" }] }] } });
    await transaction.update(wikiPages).set({ ydocState: null }).where(eq(wikiPages.id, page.id));
    const versions = await wiki.listWikiPageVersions.handler({ userId: owner.id }, { pageId: page.id });
    const { wikiPageVersions } = await import("@weft/db");
    await transaction.update(wikiPageVersions).set({ ydocState: null }).where(eq(wikiPageVersions.id, versions[0]!.id));
    expect(await migrateExistingWikiDocuments(transaction)).toEqual({ pages: 1, versions: 1 });
    const [migrated] = await transaction.select().from(wikiPages).where(eq(wikiPages.id, page.id));
    const [version] = await transaction.select().from(wikiPageVersions).where(eq(wikiPageVersions.id, versions[0]!.id));
    expect(migrated?.ydocState).toBeInstanceOf(Uint8Array);
    expect(migrated?.contentText).toBe("migrate me");
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
