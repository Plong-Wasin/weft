import { afterAll, expect, test } from "bun:test";
import { createDatabase } from "@weft/db";
import { createCommentActions, createCycleActions, createIntakeActions, createModuleActions, createProjectActions, createSignalBus, createWikiActions, createWorkItemActions, parseSignal, resolveSignalScope, type Signal } from "../src";
import { createMemberFactory, createWorkspaceFactory, withRollback } from "../../db/src/test-helpers";

const { client, db } = createDatabase();
afterAll(async () => client.end());

const url = Bun.env.DATABASE_URL ?? "postgres://weft:weft@localhost:54329/weft";

async function next(received: Signal[], count: number) {
  for (let i = 0; i < 100 && received.length < count; i++) await Bun.sleep(50);
  return received;
}

test.concurrent("a signal published by one bus instance reaches subscribers of another through LISTEN/NOTIFY", async () => {
  const a = createSignalBus(url);
  const b = createSignalBus(url);
  try {
    const received: Signal[] = [];
    const workspaceId = crypto.randomUUID();
    b.subscribe((signal) => { if (signal.workspaceId === workspaceId) received.push(signal); });
    await b.ready();
    await a.publish({ type: "change", workspaceId, projectId: "p1" });
    expect(await next(received, 1)).toEqual([{ type: "change", workspaceId, projectId: "p1" }]);
  } finally {
    await a.close();
    await b.close();
  }
});

test.concurrent("an unsubscribed listener hears nothing more", async () => {
  const bus = createSignalBus(url);
  try {
    const received: Signal[] = [];
    const workspaceId = crypto.randomUUID();
    const off = bus.subscribe((signal) => { if (signal.workspaceId === workspaceId) received.push(signal); });
    await bus.ready();
    await bus.publish({ type: "notification", workspaceId, userId: "u1" });
    await next(received, 1);
    off();
    await bus.publish({ type: "notification", workspaceId, userId: "u2" });
    await Bun.sleep(300);
    expect(received).toEqual([{ type: "notification", workspaceId, userId: "u1" }]);
  } finally {
    await bus.close();
  }
});

test("signals carry only routing ids: parseSignal drops extra fields and rejects junk", () => {
  expect(parseSignal(JSON.stringify({ type: "change", workspaceId: "w", title: "secret" }))).toEqual({ type: "change", workspaceId: "w" });
  expect(parseSignal(JSON.stringify({ type: "notification", workspaceId: "w", userId: "u", body: "x" }))).toEqual({ type: "notification", workspaceId: "w", userId: "u" });
  expect(parseSignal("not json")).toBeNull();
  expect(parseSignal(JSON.stringify({ type: "other" }))).toBeNull();
});

test.concurrent("resolveSignalScope finds the workspace from a wiki pageId or a commentId", async () => {
  await withRollback(db, async (transaction) => {
    const workspace = await createWorkspaceFactory(transaction);
    const admin = await createMemberFactory(transaction, workspace.id, "Admin");
    const wiki = createWikiActions(transaction);
    const page = await wiki.createWikiPage.handler({ userId: admin.id }, { workspaceId: workspace.id, title: "P" });
    expect(await resolveSignalScope(transaction, { pageId: page.id }, { deleted: 1 })).toEqual({ workspaceId: workspace.id, pageId: page.id });
    const project = await createProjectActions(transaction).createProject.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "M", key: "MOB", visibility: "public" });
    const item = await createWorkItemActions(transaction).createWorkItem.handler({ userId: admin.id }, { projectId: project.id, title: "I" });
    const comment = await createCommentActions(transaction).createComment.handler({ userId: admin.id }, { workItemId: item.id, body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "x" }] }] } });
    expect(await resolveSignalScope(transaction, { commentId: comment.id }, { removed: true })).toEqual({ workspaceId: workspace.id, projectId: project.id });
  });
});

test.concurrent("resolveSignalScope resolves cycleId, moduleId and intakeItemId, including a deleted Cycle", async () => {
  await withRollback(db, async (transaction) => {
    const workspace = await createWorkspaceFactory(transaction);
    const admin = await createMemberFactory(transaction, workspace.id, "Admin");
    const project = await createProjectActions(transaction).createProject.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "M", key: "MOB", visibility: "public" });
    const expected = { workspaceId: workspace.id, projectId: project.id };
    const cycles = createCycleActions(transaction);
    const cycle = await cycles.createCycle.handler({ userId: admin.id }, { projectId: project.id, name: "S", startDate: "2030-01-01", endDate: "2030-01-10" });
    expect(await resolveSignalScope(transaction, { cycleId: cycle.id, workItemIds: [] }, { added: [] })).toEqual(expected);
    const deleted = await cycles.deleteCycle.handler({ userId: admin.id }, { cycleId: cycle.id });
    expect(await resolveSignalScope(transaction, { cycleId: cycle.id }, deleted)).toEqual(expected);
    const mod = await createModuleActions(transaction).createModule.handler({ userId: admin.id }, { projectId: project.id, name: "Auth" });
    expect(await resolveSignalScope(transaction, { moduleId: mod.id }, { removed: [] })).toEqual(expected);
    const intake = await createIntakeActions(transaction).submitIntakeItem.handler({ userId: admin.id }, { projectId: project.id, title: "Idea" });
    expect(await resolveSignalScope(transaction, { intakeItemId: intake.id }, { ok: true })).toEqual(expected);
  });
});
