import { afterAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { confirmations, createDatabase, workspaceMembers, type Database } from "@weft/db";
import {
  ActionError, createAiTools, createChatStore, createConfirmationStore, createJobHandlers, createProjectActions, createWikiActions, createWorkItemActions,
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
    for (const name of ["create_work_item", "update_work_item", "move_work_item", "delete_work_item", "create_wiki_page", "update_wiki_page"]) expect(names).toContain(name);
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
