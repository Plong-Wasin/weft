import { afterAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { confirmations, createDatabase, wikiPages, workspaceMembers, type Database } from "@weft/db";
import { wikiContentFromYState } from "../src/wiki-yjs";
import {
  ActionError, createActionList, createWebLinkActions, createAiTools, createChatStore, createConfirmationStore, createEstimateActions, createJobHandlers, createProjectActions, createWikiActions, createWorkItemActions,
  confirmationTtlMs,
} from "../src";
import { createMemberFactory, createWorkspaceFactory, withRollback } from "../../db/src/test-helpers";

const { client, db } = createDatabase();
afterAll(async () => client.end());

async function setup(transaction: Database, now: () => Date = () => new Date()) {
  const workspace = await createWorkspaceFactory(transaction);
  const alice = await createMemberFactory(transaction, workspace.id, "Member");
  const bob = await createMemberFactory(transaction, workspace.id, "Member");
  const project = await createProjectActions(transaction).createProject.handler({ userId: alice.id }, { workspaceId: workspace.id, name: "Mobile", key: "MOB", visibility: "public" });
  await createProjectActions(transaction).joinProject.handler({ userId: bob.id }, { projectId: project.id });
  const chat = (await createChatStore(transaction).upsertChat({ id: crypto.randomUUID(), workspaceId: workspace.id, userId: alice.id, title: "chat" }))!;
  const work = createWorkItemActions(transaction);
  const item = await work.createWorkItem.handler({ userId: alice.id }, { projectId: project.id, title: "Fix login" });
  return { workspace, alice, bob, project, chat, work, item, store: createConfirmationStore(transaction, { now }) };
}
const propose = (s: Awaited<ReturnType<typeof setup>>, action: string, input: Record<string, unknown>) =>
  s.store.propose({ userId: s.alice.id, workspaceId: s.workspace.id, chatId: s.chat.id, action, input });

test.concurrent("proposing never runs the action; confirming runs it as the user via AI with the chat id", async () => {
  await withRollback(db, async (tx) => {
    const s = await setup(tx);
    const card = await propose(s, "update_work_item", { workItemId: s.item.id, title: "Fix login redirect" });
    expect(card.input).toEqual({ workItemId: s.item.id, title: "Fix login redirect" });
    expect((await s.work.getWorkItem.handler({ userId: s.alice.id }, { workspaceId: s.workspace.id, displayId: "MOB-1" })).title).toBe("Fix login");

    const outcome = await s.store.confirm(s.alice.id, card.id);
    expect(outcome.status).toBe("confirmed");
    expect((await s.work.getWorkItem.handler({ userId: s.alice.id }, { workspaceId: s.workspace.id, displayId: "MOB-1" })).title).toBe("Fix login redirect");
    const activities = await s.work.listWorkItemActivities.handler({ userId: s.alice.id }, { workItemId: s.item.id });
    const titleChange = activities.find((row) => row.field === "title" && row.newValue === "Fix login redirect")!;
    expect(titleChange.source).toBe("ai");
    expect(titleChange.chatId).toBe(s.chat.id);
    expect(titleChange.actorId).toBe(s.alice.id);
    // a card runs once
    expect((await s.store.confirm(s.alice.id, card.id)).status).toBe("already_resolved");
  });
});

test.concurrent("creating a work item and a wiki page can be proposed and confirmed", async () => {
  await withRollback(db, async (tx) => {
    const s = await setup(tx);
    const created = await s.store.confirm(s.alice.id, (await propose(s, "create_work_item", { projectId: s.project.id, title: "New thing" })).id);
    expect(created.status).toBe("confirmed");
    const page = await s.store.confirm(s.alice.id, (await propose(s, "create_wiki_page", { title: "Plan" })).id);
    expect(page.status).toBe("confirmed");
    const pages = await createWikiActions(tx).listWikiPages.handler({ userId: s.alice.id }, { workspaceId: s.workspace.id });
    expect(pages.map((row) => row.title)).toContain("Plan");
  });
});

test.concurrent("AI page updates remain proposals until confirmed and save the previous content as a version", async () => {
  await withRollback(db, async (tx) => {
    const s = await setup(tx);
    const wiki = createWikiActions(tx);
    const page = await wiki.createWikiPage.handler({ userId: s.alice.id }, { workspaceId: s.workspace.id, title: "Draft", content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "before" }] }] } });
    const card = await propose(s, "update_wiki_page", { pageId: page.id, content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "after" }] }] } });
    expect((await wiki.getWikiPage.handler({ userId: s.alice.id }, { pageId: page.id })).contentText).toBe("before");
    expect((await wiki.listWikiPageVersions.handler({ userId: s.alice.id }, { pageId: page.id }))).toHaveLength(1);
    expect((await s.store.confirm(s.alice.id, card.id)).status).toBe("confirmed");
    expect((await wiki.getWikiPage.handler({ userId: s.alice.id }, { pageId: page.id })).contentText).toBe("after");
    const versions = await wiki.listWikiPageVersions.handler({ userId: s.alice.id }, { pageId: page.id });
    expect(versions).toHaveLength(2);
    const { wikiPageVersions } = await import("@weft/db");
    const saved = await tx.select().from(wikiPageVersions).where(eq(wikiPageVersions.pageId, page.id));
    const prior = saved.find((version) => version.contentText === "before");
    expect(prior?.contentText).toBe("before");
    const restored = await wiki.restoreWikiPageVersion.handler({ userId: s.alice.id }, { pageId: page.id, versionId: prior!.id });
    expect(restored.contentText).toBe("before");
  });
});

test.concurrent("AI cannot prepare a move proposal for a Page outside the caller's project", async () => {
  await withRollback(db, async (tx) => {
    const s = await setup(tx);
    const outsider = await createMemberFactory(tx, s.workspace.id, "Member");
    const chat = (await createChatStore(tx).upsertChat({ id: crypto.randomUUID(), workspaceId: s.workspace.id, userId: outsider.id, title: "chat" }))!;
    const page = await createWikiActions(tx).createWikiPage.handler({ userId: s.alice.id }, {
      workspaceId: s.workspace.id, projectId: s.project.id, title: "Private to project",
    });
    await expect(s.store.propose({
      userId: outsider.id, workspaceId: s.workspace.id, chatId: chat.id,
      action: "move_page_scope", input: { pageId: page.id, projectId: null },
    })).rejects.toMatchObject({ status: 404 });
  });
});

test.concurrent("only the proposing user can see or confirm a card", async () => {
  await withRollback(db, async (tx) => {
    const s = await setup(tx);
    const card = await propose(s, "update_work_item", { workItemId: s.item.id, title: "x" });
    expect(await s.store.get(s.bob.id, card.id)).toBeNull();
    await expect(s.store.confirm(s.bob.id, card.id)).rejects.toMatchObject({ status: 404 });
    expect((await s.store.get(s.alice.id, card.id))?.status).toBe("pending");
  });
});

test.concurrent("a card expires after 24 hours and then refuses to run", async () => {
  await withRollback(db, async (tx) => {
    let clock = new Date("2026-01-01T00:00:00Z");
    const s = await setup(tx, () => clock);
    const card = await propose(s, "update_work_item", { workItemId: s.item.id, title: "late" });
    expect(new Date(card.expiresAt).getTime() - clock.getTime()).toBe(confirmationTtlMs);
    expect(confirmationTtlMs).toBe(24 * 60 * 60 * 1000);

    clock = new Date(clock.getTime() + confirmationTtlMs - 1000);
    expect((await s.store.get(s.alice.id, card.id))?.status).toBe("pending");
    clock = new Date(clock.getTime() + 2000);
    expect((await s.store.get(s.alice.id, card.id))?.status).toBe("expired");
    expect((await s.store.confirm(s.alice.id, card.id)).status).toBe("expired");
    expect((await s.work.getWorkItem.handler({ userId: s.alice.id }, { workspaceId: s.workspace.id, displayId: "MOB-1" })).title).toBe("Fix login");
  });
});

test.concurrent("stale target state: confirm returns a diff first and runs only once the user accepts the changes", async () => {
  await withRollback(db, async (tx) => {
    const s = await setup(tx);
    const card = await propose(s, "update_work_item", { workItemId: s.item.id, priority: "high" });
    await s.work.updateWorkItem.handler({ userId: s.bob.id }, { workItemId: s.item.id, title: "Renamed by Bob", priority: "low" });

    const first = await s.store.confirm(s.alice.id, card.id);
    expect(first.status).toBe("changed");
    if (first.status !== "changed") throw new Error("unreachable");
    expect(first.diff).toEqual(expect.arrayContaining([
      { field: "title", before: "Fix login", after: "Renamed by Bob" },
      { field: "priority", before: "none", after: "low" },
    ]));
    expect((await s.work.getWorkItem.handler({ userId: s.alice.id }, { workspaceId: s.workspace.id, displayId: "MOB-1" })).priority).toBe("low");
    expect((await s.store.get(s.alice.id, card.id))?.status).toBe("pending");

    const second = await s.store.confirm(s.alice.id, card.id, { acknowledgeChanges: true });
    expect(second.status).toBe("confirmed");
    expect((await s.work.getWorkItem.handler({ userId: s.alice.id }, { workspaceId: s.workspace.id, displayId: "MOB-1" })).priority).toBe("high");
  });
});

test.concurrent("a deleted target cannot be confirmed", async () => {
  await withRollback(db, async (tx) => {
    const s = await setup(tx);
    const card = await propose(s, "update_work_item", { workItemId: s.item.id, title: "x" });
    await s.work.deleteWorkItem.handler({ userId: s.alice.id }, { workItemId: s.item.id });
    const outcome = await s.store.confirm(s.alice.id, card.id);
    expect(outcome.status).toBe("failed");
  });
});

test.concurrent("permission lost between proposal and confirm: nothing runs", async () => {
  await withRollback(db, async (tx) => {
    const s = await setup(tx);
    const card = await propose(s, "update_work_item", { workItemId: s.item.id, title: "after demotion" });
    await tx.update(workspaceMembers).set({ role: "Guest" }).where(eq(workspaceMembers.userId, s.alice.id));
    const outcome = await s.store.confirm(s.alice.id, card.id);
    expect(outcome.status).toBe("failed");
    expect((await s.work.getWorkItem.handler({ userId: s.bob.id }, { workspaceId: s.workspace.id, displayId: "MOB-1" })).title).toBe("Fix login");

    const second = await setup(tx);
    const creation = await propose(second, "create_work_item", { projectId: second.project.id, title: "created after removal" });
    await tx.delete(workspaceMembers).where(eq(workspaceMembers.userId, second.alice.id));
    expect((await second.store.confirm(second.alice.id, creation.id)).status).toBe("failed");
  });
});

test.concurrent("proposals are validated: unknown, destructive-at-scale, invalid, and cross-workspace requests are refused", async () => {
  await withRollback(db, async (tx) => {
    const s = await setup(tx);
    for (const action of ["delete_project", "delete_workspace", "create_api_token", "change_member_role", "list_work_items", "nonsense"]) {
      await expect(propose(s, action, {})).rejects.toBeInstanceOf(ActionError);
    }
    await expect(propose(s, "update_work_item", { workItemId: "not-a-uuid" })).rejects.toMatchObject({ status: 400 });
    const other = await setup(tx);
    await expect(propose(s, "update_work_item", { workItemId: other.item.id, title: "x" })).rejects.toBeInstanceOf(ActionError);
    // a user who cannot read the target gets no card for it
    const outsider = await createMemberFactory(tx, (await createWorkspaceFactory(tx)).id, "Member");
    await expect(s.store.propose({ userId: outsider.id, workspaceId: s.workspace.id, chatId: s.chat.id, action: "update_work_item", input: { workItemId: s.item.id, title: "x" } })).rejects.toBeInstanceOf(ActionError);
  });
});

test.concurrent("reject closes a card; AI write tools only propose and never execute", async () => {
  await withRollback(db, async (tx) => {
    const s = await setup(tx);
    const tools = createAiTools(tx, { userId: s.alice.id, workspaceId: s.workspace.id, chatId: s.chat.id });
    const names = tools.map((tool) => tool.name);
    for (const name of ["create_work_item", "update_work_item", "move_work_item", "delete_work_item", "create_wiki_page", "update_wiki_page", "move_wiki_page", "move_page_scope", "delete_wiki_page", "restore_wiki_page_version"]) expect(names).toContain(name);
    expect(names).not.toContain("link_wiki_page_to_project");
    for (const name of ["delete_project", "delete_workspace", "create_workspace", "create_api_token", "change_member_role"]) expect(names).not.toContain(name);

    const output = await tools.find((tool) => tool.name === "update_work_item")!.execute({ workItemId: s.item.id, title: "Sneaky" });
    const proposal = JSON.parse(output) as { confirmationId: string; status: string };
    expect(proposal.status).toBe("awaiting_user_confirmation");
    expect((await s.work.getWorkItem.handler({ userId: s.alice.id }, { workspaceId: s.workspace.id, displayId: "MOB-1" })).title).toBe("Fix login");

    const invalid = JSON.parse(await tools.find((tool) => tool.name === "update_work_item")!.execute({ workItemId: "bad" })) as { error: string };
    expect(invalid.error).toBeTruthy();

    expect((await s.store.reject(s.alice.id, proposal.confirmationId)).status).toBe("rejected");
    expect((await s.store.confirm(s.alice.id, proposal.confirmationId)).status).toBe("already_resolved");
  });
});

test.concurrent("cleanup_confirmations deletes rows past expiry and keeps live ones", async () => {
  await withRollback(db, async (tx) => {
    const s = await setup(tx);
    const live = await propose(s, "update_work_item", { workItemId: s.item.id, title: "live" });
    const old = await propose(s, "update_work_item", { workItemId: s.item.id, title: "old" });
    await tx.update(confirmations).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(confirmations.id, old.id));
    await createJobHandlers().cleanup_confirmations!(tx, {}, { id: "j", type: "cleanup_confirmations" });
    const left = (await tx.select({ id: confirmations.id }).from(confirmations)).map((row) => row.id);
    expect(left).toContain(live.id);
    expect(left).not.toContain(old.id);
  });
});

/** A store whose `update_work_item` runs `handler`, to reach failure paths a real Action cannot be made to hit. */
function storeWith(tx: Database, handler: () => Promise<unknown>) {
  const real = createActionList(tx).find((action) => action.name === "update_work_item")!;
  return createConfirmationStore(tx, { actions: [{ ...real, handler } as never] });
}

test.concurrent("an unexpected error in the action is recorded as failed, not left confirmed, and still surfaces", async () => {
  await withRollback(db, async (tx) => {
    const s = await setup(tx);
    const store = storeWith(tx, async () => { throw new Error("boom"); });
    const card = await store.propose({ userId: s.alice.id, workspaceId: s.workspace.id, chatId: s.chat.id, action: "update_work_item", input: { workItemId: s.item.id, title: "x" } });
    await expect(store.confirm(s.alice.id, card.id)).rejects.toThrow("boom");
    expect((await store.get(s.alice.id, card.id))?.status).toBe("failed");
    expect((await store.confirm(s.alice.id, card.id)).status).toBe("already_resolved");
  });
});

test.concurrent("a transient error while re-validating before the claim leaves the proposal pending so it can be retried", async () => {
  await withRollback(db, async (tx) => {
    const s = await setup(tx);
    const card = await propose(s, "update_work_item", { workItemId: s.item.id, title: "retry me" });
    // The first confirm hits a non-Action error while loading the target; the card must stay pending.
    const flaky = new Proxy(tx, { get: (target, key, receiver) => (key === "select" ? () => { throw new Error("connection reset"); } : Reflect.get(target, key, receiver)) });
    const store = createConfirmationStore(flaky as unknown as Database);
    await expect(store.confirm(s.alice.id, card.id)).rejects.toThrow();
    expect((await s.store.get(s.alice.id, card.id))?.status).toBe("pending");
    expect((await s.store.confirm(s.alice.id, card.id)).status).toBe("confirmed");
  });
});

test.concurrent("a Web Link from another workspace cannot be proposed for update or delete", async () => {
  await withRollback(db, async (tx) => {
    const s = await setup(tx);
    const otherWorkspace = await createWorkspaceFactory(tx);
    const eve = await createMemberFactory(tx, otherWorkspace.id, "Member");
    const otherProject = await createProjectActions(tx).createProject.handler({ userId: eve.id }, { workspaceId: otherWorkspace.id, name: "Other", key: "OTH", visibility: "public" });
    const otherItem = await createWorkItemActions(tx).createWorkItem.handler({ userId: eve.id }, { projectId: otherProject.id, title: "Elsewhere" });
    const link = await createWebLinkActions(tx).createWebLink.handler({ userId: eve.id }, { workItemId: otherItem.id, url: "https://example.com" });
    await expect(propose(s, "delete_web_link", { webLinkId: link.id })).rejects.toMatchObject({ status: 404 });
    await expect(propose(s, "update_web_link", { webLinkId: link.id, title: "x" })).rejects.toMatchObject({ status: 404 });
  });
});

test.concurrent("an AI proposal cannot target a page in a private Collection the user cannot read, but a sharee can", async () => {
  await withRollback(db, async (tx) => {
    const s = await setup(tx);
    const wiki = createWikiActions(tx);
    const collection = await wiki.createCollection.handler({ userId: s.bob.id }, { workspaceId: s.workspace.id, name: "Private", visibility: "private" });
    const page = await wiki.createWikiPage.handler({ userId: s.bob.id }, { workspaceId: s.workspace.id, collectionId: collection.id, title: "Secret" });
    await expect(propose(s, "update_wiki_page", { pageId: page.id, title: "Nope" })).rejects.toMatchObject({ status: 404 });
    await wiki.shareWikiPage.handler({ userId: s.bob.id }, { pageId: page.id, userId: s.alice.id, role: "edit" });
    await expect(propose(s, "update_wiki_page", { pageId: page.id, title: "Yes" })).resolves.toBeDefined();
  });
});

test.concurrent("stale target state shows the Estimate point by value, not by id", async () => {
  await withRollback(db, async (tx) => {
    const s = await setup(tx);
    const estimate = await createEstimateActions(tx).createEstimate.handler({ userId: s.alice.id }, { projectId: s.project.id, type: "points", values: ["1", "2", "3", "5"] });
    const point = (value: string) => estimate.points.find((entry) => entry.value === value)!.id;
    const card = await propose(s, "update_work_item", { workItemId: s.item.id, estimatePointId: point("5") });
    await s.work.updateWorkItem.handler({ userId: s.bob.id }, { workItemId: s.item.id, estimatePointId: point("3") });

    const first = await s.store.confirm(s.alice.id, card.id);
    expect(first.status).toBe("changed");
    if (first.status !== "changed") throw new Error("unreachable");
    expect(first.diff).toEqual(expect.arrayContaining([{ field: "estimate", before: null, after: "3" }]));
  });
});

test.concurrent("AI page content in Markdown is stored as an editor document with a live Yjs state", async () => {
  await withRollback(db, async (tx) => {
    const s = await setup(tx);
    const wiki = createWikiActions(tx);
    const card = await propose(s, "create_wiki_page", { title: "Guide", content: "# Intro\n\nHello **world**" });
    // The stored proposal already holds the document the user is shown, not the raw Markdown.
    expect((card.input.content as { type: string }).type).toBe("doc");
    expect((await s.store.confirm(s.alice.id, card.id)).status).toBe("confirmed");
    const [page] = (await wiki.listWikiPages.handler({ userId: s.alice.id }, { workspaceId: s.workspace.id })).filter((row) => row.title === "Guide");
    const full = await wiki.getWikiPage.handler({ userId: s.alice.id }, { pageId: page!.id });
    expect((full.content as { type: string }).type).toBe("doc");
    expect(full.contentText).toContain("Hello world");
    const [row] = await tx.select({ ydocState: wikiPages.ydocState }).from(wikiPages).where(eq(wikiPages.id, page!.id));
    expect(JSON.stringify(wikiContentFromYState(row!.ydocState!))).toContain("Hello ");
    const [version] = await wiki.listWikiPageVersions.handler({ userId: s.alice.id }, { pageId: page!.id });
    const restored = await wiki.restoreWikiPageVersion.handler({ userId: s.alice.id }, { pageId: page!.id, versionId: version!.id });
    expect((restored.content as { type: string }).type).toBe("doc");
  });
});

test.concurrent("a proposal whose page content is neither Markdown nor a document is refused", async () => {
  await withRollback(db, async (tx) => {
    const s = await setup(tx);
    await expect(propose(s, "create_wiki_page", { title: "Bad", content: 42 })).rejects.toMatchObject({ status: 400 });
    await expect(propose(s, "create_wiki_page", { title: "Bad", content: { foo: 1 } })).rejects.toMatchObject({ status: 400 });
  });
});
