import { Server } from "@hocuspocus/server";
import * as Y from "yjs";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { Database } from "@weft/db";
import { wikiPageVersions, wikiPages } from "@weft/db";
import { ActionError, createSignalBus, createWikiActions, normalizeAssetImages, plainText, createWikiYDoc, replaceWikiYDocContent, wikiContentFromYState, wikiYFragment, wikiYState, type SignalBus } from "@weft/actions";

const fragmentName = wikiYFragment;
export const documentFromContent = createWikiYDoc;
export const encodeDocument = wikiYState;
export const documentContent = (document: Y.Doc) => wikiContentFromYState(encodeDocument(document));

export async function migrateExistingWikiDocuments(db: Database) {
  let convertedPages = 0;
  const pages = await db.select().from(wikiPages).where(isNull(wikiPages.ydocState));
  for (const page of pages) {
    try {
      const document = createWikiYDoc(page.content);
      try {
      const state = encodeDocument(document);
      const content = documentContent(document);
      await db.update(wikiPages).set({ ydocState: state, content, contentText: plainText(content) }).where(and(eq(wikiPages.id, page.id), isNull(wikiPages.ydocState)));
      convertedPages++;
      } finally { document.destroy(); }
    } catch (error) { console.error(`Skipping wiki page ${page.id} during Yjs migration`, error); }
  }
  const versions = await db.select().from(wikiPageVersions).where(isNull(wikiPageVersions.ydocState));
  let convertedVersions = 0;
  for (const version of versions) {
    // One legacy row outside the editor schema must not stop the server from starting.
    try {
      const document = createWikiYDoc(version.content);
      try {
        await db.update(wikiPageVersions).set({ ydocState: encodeDocument(document) })
          .where(and(eq(wikiPageVersions.id, version.id), isNull(wikiPageVersions.ydocState)));
        convertedVersions++;
      } finally { document.destroy(); }
    } catch (error) { console.error(`Skipping wiki page version ${version.id} during Yjs migration`, error); }
  }
  return { pages: convertedPages, versions: convertedVersions };
}

/** Close reason telling a web client to drop its local document and reconnect from the stored state (Hocuspocus delivers the reason, not the code, to the browser). */
export const resyncReason = "Page resync";

function readVarUint(data: Uint8Array, offset: number): [number, number] {
  let value = 0, shift = 0;
  while (offset < data.length) {
    const byte = data[offset++]!;
    value += (byte & 0x7f) * 2 ** shift;
    if (byte < 0x80) return [value, offset];
    shift += 7;
  }
  return [-1, offset];
}
/** True when a raw Hocuspocus message is a Yjs update (or sync step 2) that adds something the document does not hold yet. */
function carriesChanges(message: Uint8Array, document: Y.Doc) {
  try {
    let [nameLength, offset] = readVarUint(message, 0);
    offset += nameLength;
    let type: number, syncType: number;
    [type, offset] = readVarUint(message, offset);
    if (type !== 0) return false;
    [syncType, offset] = readVarUint(message, offset);
    if (syncType !== 1 && syncType !== 2) return false;
    let length: number;
    [length, offset] = readVarUint(message, offset);
    if (length < 0) return false;
    return !Y.snapshotContainsUpdate(Y.snapshot(document), message.subarray(offset, offset + length));
  } catch { return false; }
}

export function createLiveServer(options: {
  db: Database;
  authenticate: (token: string, headers: Headers) => Promise<string | null>;
  port?: number;
  address?: string;
  bus?: SignalBus;
  webOrigins?: string[];
}) {
  const bus = options.bus ?? createSignalBus();
  const actions = createWikiActions(options.db);
  // Connections whose document changes were refused while read-only. Their client documents are ahead of ours.
  const droppedWhileReadOnly = new WeakSet<object>();
  const accessTimers = new Map<string, ReturnType<typeof setInterval>>();
  // The stored content (as the database returns it) that each live document last matched. A different stored value means another writer (AI, restore) changed the page and the live document must take it before saving again; a title rename leaves content alone and must not block saving.
  const knownContent = new WeakMap<Y.Doc, string>();
  // Odd while a save is running, and different after one finishes: the change handler uses it to notice that a save overlapped its read.
  const saveEpoch = new WeakMap<Y.Doc, number>();
  const bumpSaveEpoch = (document: Y.Doc) => saveEpoch.set(document, (saveEpoch.get(document) ?? 0) + 1);
  const server = new Server({
    port: options.port ?? 0,
    address: options.address ?? "127.0.0.1",
    debounce: 250,
    maxDebounce: 2_000,
    async onAuthenticate({ token, documentName, connectionConfig, requestHeaders }) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(documentName)) throw new Error("Invalid page id");
      const origins = options.webOrigins ?? (process.env.WEB_ORIGIN ? process.env.WEB_ORIGIN.split(",").map((origin) => origin.trim()) : ["http://localhost:5173"]);
      const origin = new Headers(requestHeaders as HeadersInit).get("origin");
      // Browser WebSockets always carry Origin; allow headless clients that omit it entirely.
      if (origin && !origins.includes(origin)) throw new Error("Origin not allowed");
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
    async beforeHandleMessage({ connection, context, documentName, update, document }) {
      await refreshAccess((context as { userId: string }).userId, documentName, connection);
      if (connection.readOnly && carriesChanges(update, document)) droppedWhileReadOnly.add(connection);
    },
    async onLoadDocument({ documentName, document }) {
      const [page] = await options.db.select().from(wikiPages).where(and(eq(wikiPages.id, documentName), isNull(wikiPages.deletedAt)));
      if (!page) throw new Error("Page not found");
      // A load never writes: a locked page, a read-only viewer and a legacy page must all leave the row alone. Migrated or normalised content stays in memory and the next real save persists it; knownContent keeps the stored value so that save passes the stale-content guard.
      if (page.ydocState) Y.applyUpdate(document, page.ydocState);
      else {
        const migrated = documentFromContent(page.content);
        Y.applyUpdate(document, Y.encodeStateAsUpdate(migrated));
        migrated.destroy();
      }
      const normalized = normalizeAssetImages(page.content);
      if (JSON.stringify(normalized) !== JSON.stringify(page.content)) replaceWikiYDocContent(document, normalized);
      knownContent.set(document, JSON.stringify(page.content));
      return document;
    },
    async onStoreDocument({ documentName, document, context }) {
      const content = documentContent(document);
      const contentText = plainText(content);
      bumpSaveEpoch(document);
      try { await options.db.transaction(async (tx) => {
        const db = tx as unknown as Database;
        const [page] = await db.select().from(wikiPages).where(and(eq(wikiPages.id, documentName), isNull(wikiPages.deletedAt))).for("update");
        if (!page) return;
        if (page.lockedAt) {
          // Nothing is saved while locked, and nothing typed in the lock window may come back after unlock.
          resetToStored(document, page.content);
          knownContent.set(document, JSON.stringify(page.content));
          return;
        }
        if (JSON.stringify(page.content) !== knownContent.get(document)) {
          // Someone else wrote the page outside this document; the change signal resyncs the editors, so this save is dropped on purpose.
          console.warn(`Skipped live save for wiki page ${page.id}: stored content changed outside the live document`);
          return;
        }
        const state = encodeDocument(document);
        const changed = JSON.stringify(content) !== JSON.stringify(page.content);
        const [latest] = await db.select({ createdAt: wikiPageVersions.createdAt }).from(wikiPageVersions)
          .where(eq(wikiPageVersions.pageId, page.id)).orderBy(desc(wikiPageVersions.createdAt)).limit(1);
        const savedAt = new Date();
        const [updated] = await db.update(wikiPages).set({ ydocState: state, content, contentText, updatedAt: savedAt }).where(eq(wikiPages.id, page.id)).returning();
        knownContent.set(document, JSON.stringify(updated!.content));
        if (changed && (!latest || Date.now() - latest.createdAt.getTime() >= 5 * 60_000)) {
          await db.insert(wikiPageVersions).values({ pageId: page.id, title: page.title, content, contentText, ydocState: state, createdBy: context?.userId ?? page.ownerId });
        }
        if (changed) {
          // Effects (mention notifications, work item links) validate against the typist's access. A rejected effect must not crash the server or discard the save, so it runs in a savepoint whose failure is only logged.
          try {
            await db.transaction(async (effects) => {
              await actions.processPageContentEffects(effects as unknown as Database, { userId: context?.userId ?? page.ownerId, source: "ui" }, updated!, page.content, content, !latest || Date.now() - latest.createdAt.getTime() >= 5 * 60_000);
            });
          } catch (error) {
            console.warn(`Skipped content effects for wiki page ${page.id}`, error);
          }
        }
      }); } finally { bumpSaveEpoch(document); }
    },
  });
  async function refreshAccess(userId: string, documentName: string, connection: { readOnly: boolean; close: (options: { code: number; reason: string }) => void }) {
    try {
      const access = await actions.getWikiPageAccess.handler({ userId }, { pageId: documentName });
      // Updates sent while the connection was read-only were dropped here but stay in the writer's own document, so its clock is ahead of ours and its next update would park in pendingStructs forever. Closing on the way back to writable makes the client throw that document away and resync from the stored state.
      const regainedWrite = connection.readOnly && access.canWrite;
      connection.readOnly = !access.canWrite;
      if (regainedWrite && droppedWhileReadOnly.has(connection)) connection.close({ code: 4004, reason: resyncReason });
    } catch (error) {
      if (!(error instanceof ActionError) || ![403, 404].includes(error.status)) throw error;
      connection.close({ code: 4003, reason: "Page access revoked" });
    }
  }
  function resetToStored(document: Y.Doc, stored: unknown) {
    const normalized = normalizeAssetImages(stored);
    if (JSON.stringify(documentContent(document)) !== JSON.stringify(normalized)) replaceWikiYDocContent(document, normalized);
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
    const applyChange = async (attempt: number): Promise<void> => {
      // Lock, unlock and share changes reach every connected editor now instead of on its next message or the 10 s timer.
      await Promise.all([...liveDocument.connections.values()].map(({ connection }) =>
        refreshAccess(connection.context?.userId, signal.pageId!, connection).catch((error) => console.error("Failed to refresh live page access", error))));
      const epoch = saveEpoch.get(liveDocument) ?? 0;
      const [page] = await options.db.select({ content: wikiPages.content, lockedAt: wikiPages.lockedAt }).from(wikiPages)
        .where(and(eq(wikiPages.id, signal.pageId!), isNull(wikiPages.deletedAt)));
      if (!page) return;
      // A save that ran, or is running, while the page was read makes the read stale: comparing it with knownContent would wipe fresh typing. Try again once the save has settled.
      if ((saveEpoch.get(liveDocument) ?? 0) !== epoch || epoch % 2 === 1) {
        if (attempt < 5) { await Bun.sleep(100); return applyChange(attempt + 1); }
        return;
      }
      // Only a content write by someone else replaces the live document; a title change leaves unsaved typing alone. A locked page always shows its stored content.
      const stored = JSON.stringify(page.content);
      if (stored !== knownContent.get(liveDocument)) {
        replaceWikiYDocContent(liveDocument, page.content);
        knownContent.set(liveDocument, stored);
      } else if (page.lockedAt) resetToStored(liveDocument, page.content);
    };
    void applyChange(0).catch((error) => console.error("Failed to apply page change to live document", error));
  });
  return {
    get url() { return server.webSocketURL; },
    /** Exposed for tests that inspect live connections. */
    get hocuspocus() { return server.hocuspocus; },
    listen: async () => { await bus.ready(); return server.listen(); },
    destroy: async () => { off(); await server.destroy(); if (!options.bus) await bus.close(); },
  };
}
