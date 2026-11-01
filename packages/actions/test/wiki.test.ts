import { afterAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { createDatabase, type Database } from "@weft/db";
import { ActionError, createWikiActions, lockTimeoutMs, versionIntervalMs } from "../src";
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

test.concurrent("autosave versions on a cadence and restore brings back an old version", async () => {
  await withRollback(db, async (tx) => {
    const { alice, wiki, create, advance } = await setup(tx);
    const page = await create(alice.id, "Plan", { content: doc("v1") });
    const save = (text: string) => wiki.updateWikiPage.handler({ userId: alice.id }, { pageId: page.id, content: doc(text) });
    const count = async () => (await wiki.listWikiPageVersions.handler({ userId: alice.id }, { pageId: page.id })).length;
    expect(await count()).toBe(1);
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
    expect(await count()).toBe(3);
    expect((await failure(wiki.restoreWikiPageVersion.handler({ userId: alice.id }, { pageId: page.id, versionId: crypto.randomUUID() })))?.status).toBe(404);
  });
});

test.concurrent("single-editor lock: shown to others, blocks their saves, expires, and can be taken over", async () => {
  await withRollback(db, async (tx) => {
    const { alice, bob, wiki, create, advance } = await setup(tx);
    const page = await create(alice.id, "Shared");
    const held = await wiki.acquireWikiLock.handler({ userId: alice.id }, { pageId: page.id });
    expect(held.lock?.userId).toBe(alice.id);
    expect((await wiki.getWikiPage.handler({ userId: bob.id }, { pageId: page.id })).lock?.userId).toBe(alice.id);
    expect((await failure(wiki.updateWikiPage.handler({ userId: bob.id }, { pageId: page.id, title: "Bob" })))?.status).toBe(409);
    expect((await failure(wiki.acquireWikiLock.handler({ userId: bob.id }, { pageId: page.id })))?.status).toBe(409);
    advance(lockTimeoutMs - 1000);
    await wiki.acquireWikiLock.handler({ userId: alice.id }, { pageId: page.id }); // heartbeat
    advance(lockTimeoutMs - 1000);
    expect((await wiki.getWikiPage.handler({ userId: bob.id }, { pageId: page.id })).lock?.userId).toBe(alice.id);
    advance(2000);
    expect((await wiki.getWikiPage.handler({ userId: bob.id }, { pageId: page.id })).lock).toBeNull();
    const saved = await wiki.updateWikiPage.handler({ userId: bob.id }, { pageId: page.id, title: "Bob" });
    expect(saved.lock?.userId).toBe(bob.id);
    const taken = await wiki.acquireWikiLock.handler({ userId: alice.id }, { pageId: page.id, takeover: true });
    expect(taken.lock?.userId).toBe(alice.id);
    expect(await wiki.releaseWikiLock.handler({ userId: bob.id }, { pageId: page.id })).toEqual({ released: false });
    expect(await wiki.releaseWikiLock.handler({ userId: alice.id }, { pageId: page.id })).toEqual({ released: true });
    expect((await wiki.getWikiPage.handler({ userId: bob.id }, { pageId: page.id })).lock).toBeNull();
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
    await wiki.deleteWikiPage.handler({ userId: alice.id }, { pageId: gone.id });
    const find = (userId: string, query: string) => wiki.searchWikiPages.handler({ userId }, { workspaceId: workspace.id, query }).then((rows) => rows.map((row) => row.title));
    expect(await find(bob.id, "release")).toEqual(["Deploy guide"]);
    expect(await find(alice.id, "release")).toEqual(["Deploy guide", "Secret plan"]);
    expect(await find(bob.id, "เริ่มงาน")).toEqual(["คู่มือใหม่"]);
    expect(await find(bob.id, "deploy")).toEqual(["Deploy guide"]);
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
