import { Server } from "@hocuspocus/server";
import * as Y from "yjs";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { Database } from "@weft/db";
import { wikiPageVersions, wikiPages } from "@weft/db";
import { ActionError, createSignalBus, createWikiActions, plainText, createWikiYDoc, replaceWikiYDocContent, wikiContentFromYState, wikiYFragment, wikiYState, type SignalBus } from "@weft/actions";

const fragmentName = wikiYFragment;
export const documentFromContent = createWikiYDoc;
export const encodeDocument = wikiYState;
export const documentContent = (document: Y.Doc) => wikiContentFromYState(encodeDocument(document));

export async function migrateExistingWikiDocuments(db: Database) {
  const pages = await db.select().from(wikiPages).where(isNull(wikiPages.ydocState));
  for (const page of pages) {
    const document = createWikiYDoc(page.content);
    try {
      const state = encodeDocument(document);
      const content = documentContent(document);
      await db.update(wikiPages).set({ ydocState: state, content, contentText: plainText(content) }).where(and(eq(wikiPages.id, page.id), isNull(wikiPages.ydocState)));
    } finally { document.destroy(); }
  }
  const versions = await db.select().from(wikiPageVersions).where(isNull(wikiPageVersions.ydocState));
  for (const version of versions) {
    const document = createWikiYDoc(version.content);
    try {
      await db.update(wikiPageVersions).set({ ydocState: encodeDocument(document) })
        .where(and(eq(wikiPageVersions.id, version.id), isNull(wikiPageVersions.ydocState)));
    } finally { document.destroy(); }
  }
  return { pages: pages.length, versions: versions.length };
}

export function createLiveServer(options: {
  db: Database;
  authenticate: (token: string, headers: Headers) => Promise<string | null>;
  port?: number;
  address?: string;
  bus?: SignalBus;
}) {
  const bus = options.bus ?? createSignalBus();
  const actions = createWikiActions(options.db);
  const accessTimers = new Map<string, ReturnType<typeof setInterval>>();
  const server = new Server({
    port: options.port ?? 0,
    address: options.address ?? "127.0.0.1",
    debounce: 250,
    maxDebounce: 2_000,
    async onAuthenticate({ token, documentName, connectionConfig, requestHeaders }) {
      const userId = await options.authenticate(token, new Headers(requestHeaders as HeadersInit));
      if (!userId) throw new Error("Unauthenticated");
      const context = { userId };
      const access = await actions.getWikiPageAccess.handler(context, { pageId: documentName });
      connectionConfig.readOnly = !access.canWrite;
      return { userId, canWrite: access.canWrite };
    },
    async onConnect({ context, documentName, socketId }) {
      const userId = (context as { userId: string }).userId;
      const timer = setInterval(() => {
        const connection = server.hocuspocus.documents.get(documentName)?.connections.get(socketId)?.connection;
        if (connection) void refreshAccess(userId, documentName, connection).catch((error) => console.error("Failed to refresh live page access", error));
      }, 10_000);
      accessTimers.set(socketId, timer);
    },
    async onDisconnect({ socketId }) {
      const timer = accessTimers.get(socketId);
      if (timer) clearInterval(timer);
      accessTimers.delete(socketId);
    },
    async beforeHandleMessage({ connection, context, documentName }) {
      await refreshAccess((context as { userId: string }).userId, documentName, connection);
    },
    async onLoadDocument({ documentName, document }) {
      const [page] = await options.db.select().from(wikiPages).where(and(eq(wikiPages.id, documentName), isNull(wikiPages.deletedAt)));
      if (!page) throw new Error("Page not found");
      if (page.ydocState) Y.applyUpdate(document, page.ydocState);
      else {
        const migrated = documentFromContent(page.content);
        Y.applyUpdate(document, Y.encodeStateAsUpdate(migrated));
        migrated.destroy();
        await options.db.update(wikiPages).set({ ydocState: encodeDocument(document) }).where(eq(wikiPages.id, page.id));
      }
      return document;
    },
    async onStoreDocument({ documentName, document, context }) {
      const content = documentContent(document);
      const contentText = plainText(content);
      await options.db.transaction(async (tx) => {
        const db = tx as unknown as Database;
        const [page] = await db.select().from(wikiPages).where(and(eq(wikiPages.id, documentName), isNull(wikiPages.deletedAt))).for("update");
        if (!page) return;
        const state = encodeDocument(document);
        const changed = JSON.stringify(content) !== JSON.stringify(page.content);
        const [latest] = await db.select({ createdAt: wikiPageVersions.createdAt }).from(wikiPageVersions)
          .where(eq(wikiPageVersions.pageId, page.id)).orderBy(desc(wikiPageVersions.createdAt)).limit(1);
        await db.update(wikiPages).set({ ydocState: state, content, contentText, updatedAt: new Date() }).where(eq(wikiPages.id, page.id));
        if (changed && (!latest || Date.now() - latest.createdAt.getTime() >= 5 * 60_000)) {
          await db.insert(wikiPageVersions).values({ pageId: page.id, title: page.title, content, contentText, ydocState: state, createdBy: context?.userId ?? page.ownerId });
        }
      });
    },
  });
  async function refreshAccess(userId: string, documentName: string, connection: { readOnly: boolean; close: (options: { code: number; reason: string }) => void }) {
    try {
      const access = await actions.getWikiPageAccess.handler({ userId }, { pageId: documentName });
      connection.readOnly = !access.canWrite;
    } catch (error) {
      if (!(error instanceof ActionError) || ![403, 404].includes(error.status)) throw error;
      connection.close({ code: 4003, reason: "Page access revoked" });
    }
  }
  const off = bus.subscribe((signal) => {
    if (signal.type === "revoke") {
      const document = server.hocuspocus.documents.get(signal.pageId);
      if (!document) return;
      for (const { connection } of document.connections.values()) {
        if (connection.context?.userId === signal.userId) connection.close({ code: 4003, reason: "Page share revoked" });
      }
      return;
    }
    if (signal.type !== "change" || !signal.pageId) return;
    const liveDocument = server.hocuspocus.documents.get(signal.pageId);
    if (!liveDocument) return;
    void options.db.select({ content: wikiPages.content }).from(wikiPages)
      .where(and(eq(wikiPages.id, signal.pageId), isNull(wikiPages.deletedAt))).then(([page]) => {
        if (page && JSON.stringify(documentContent(liveDocument)) !== JSON.stringify(page.content)) replaceWikiYDocContent(liveDocument, page.content);
      }).catch((error) => console.error("Failed to apply page change to live document", error));
  });
  return {
    get url() { return server.webSocketURL; },
    listen: async () => { await bus.ready(); return server.listen(); },
    destroy: async () => { off(); await server.destroy(); if (!options.bus) await bus.close(); },
  };
}
