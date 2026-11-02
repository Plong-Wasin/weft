import { afterAll, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { createDatabase, wikiPages, type Database } from "@weft/db";
import { ActionError, createProjectActions, createWikiActions, versionIntervalMs, wikiContentFromYState } from "../src";
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
    const state = (await wiki.getWikiPage.handler({ userId: alice.id }, { pageId: page.id }));
    expect(wikiContentFromYState((await tx.select().from(wikiPages).where(eq(wikiPages.id, page.id)))[0]!.ydocState!)).toEqual(doc("v1"));
    expect(state.contentText).toBe("v1");
    expect(await count()).toBe(3);
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
