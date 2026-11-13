import { afterAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { activities, comments, createDatabase, jobs, notifications, runs, workItemAssignees, workItemStates, workItems, type Database } from "@weft/db";
import { createMemberFactory, createWorkspaceFactory, withRollback } from "../../db/src/test-helpers";
import { autoRulesDueAt, autoRulesRunHour, autoRulesTimezone, agentMayUseAction, applyAutoRules, createAutoRuleActions, createCycleActions, createJobHandlers, createNotificationActions, createProjectActions, createWorkItemActions, scheduleAutoRules } from "../src";
import { createWorkItemArchiveActions } from "../src/work-item-archive";

const { client, db } = createDatabase();
afterAll(async () => client.end());

const dayMs = 24 * 60 * 60 * 1000;

/** A workspace with an Admin, a Member, and one project APP. The clock for the rules is 40 days after the real time, so items made now are idle. */
async function setup(tx: Database) {
  const workspace = await createWorkspaceFactory(tx);
  const admin = await createMemberFactory(tx, workspace.id, "Admin");
  const member = await createMemberFactory(tx, workspace.id, "Member");
  const projectActions = createProjectActions(tx);
  const items = createWorkItemActions(tx);
  const project = await projectActions.createProject.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "App", key: "APP", visibility: "public" });
  await projectActions.addProjectMember.handler({ userId: admin.id }, { projectId: project.id, userId: member.id, role: "Member" });
  const states = await tx.select().from(workItemStates).where(eq(workItemStates.projectId, project.id));
  const state = (group: string) => states.find((row) => row.group === group)!;
  const rules = createAutoRuleActions(tx);
  const archive = createWorkItemArchiveActions(tx);
  const now = new Date(Date.now() + 40 * dayMs);
  const item = async (title: string, stateId: string) => {
    const created = await items.createWorkItem.handler({ userId: member.id }, { projectId: project.id, title });
    await tx.update(workItems).set({ stateId }).where(eq(workItems.id, created.id));
    return created.id;
  };
  const stateOf = async (id: string) => (await tx.select().from(workItems).where(eq(workItems.id, id)))[0]!.stateId;
  const enable = (closeDays: number | null, archiveDays: number | null = null) => rules.updateAutoRules.handler({ userId: admin.id }, {
    projectId: project.id, autoCloseAfterDays: closeDays, autoCloseFromStateIds: [state("started").id], autoCloseToStateId: state("completed").id, autoArchiveAfterDays: archiveDays,
  });
  return { workspace, admin, member, project, rules, archive, now, item, stateOf, enable, started: state("started"), done: state("completed"), cancelled: state("cancelled"), tx };
}

test.concurrent("auto-close and auto-archive are off by default, and a dry run counts items without changing them", async () => withRollback(db, async (tx) => {
  const s = await setup(tx);
  const id = await s.item("Idle work", s.started.id);
  // The preview runs on the real clock, so the item must already be idle there: last touched 31 days ago.
  const old31 = new Date(Date.now() - 31 * dayMs);
  await tx.update(workItems).set({ updatedAt: old31 }).where(eq(workItems.id, id));
  await tx.update(activities).set({ createdAt: old31 }).where(eq(activities.entityId, id));
  expect(await s.rules.getAutoRules.handler({ userId: s.member.id }, { projectId: s.project.id })).toEqual({ autoCloseAfterDays: null, autoCloseFromStateIds: [], autoCloseToStateId: null, autoArchiveAfterDays: null });
  const preview = await s.rules.previewAutoRules.handler({ userId: s.admin.id }, { projectId: s.project.id, autoCloseAfterDays: 30, autoCloseFromStateIds: [s.started.id], autoCloseToStateId: s.done.id, autoArchiveAfterDays: null });
  expect(preview).toEqual({ toClose: 1, toArchive: 0 });
  expect(await s.stateOf(id)).toBe(s.started.id);
  // Rules still off: the daily run changes nothing.
  await applyAutoRules(tx, new Date());
  expect(await s.stateOf(id)).toBe(s.started.id);
}));

test.concurrent("only a project Admin changes the rules; a close target must be Done or Cancelled and watched states must be open", async () => withRollback(db, async (tx) => {
  const s = await setup(tx);
  await expect(s.rules.updateAutoRules.handler({ userId: s.member.id }, { projectId: s.project.id, autoCloseAfterDays: 30, autoCloseFromStateIds: [s.started.id], autoCloseToStateId: s.done.id, autoArchiveAfterDays: null })).rejects.toThrow();
  await expect(s.rules.updateAutoRules.handler({ userId: s.admin.id }, { projectId: s.project.id, autoCloseAfterDays: 30, autoCloseFromStateIds: [s.started.id], autoCloseToStateId: s.started.id, autoArchiveAfterDays: null })).rejects.toThrow("Done or Cancelled");
  await expect(s.rules.updateAutoRules.handler({ userId: s.admin.id }, { projectId: s.project.id, autoCloseAfterDays: 30, autoCloseFromStateIds: [s.done.id], autoCloseToStateId: s.cancelled.id, autoArchiveAfterDays: null })).rejects.toThrow("Only open states");
  await expect(s.rules.updateAutoRules.handler({ userId: s.admin.id }, { projectId: s.project.id, autoCloseAfterDays: 30, autoCloseFromStateIds: [], autoCloseToStateId: s.done.id, autoArchiveAfterDays: null })).rejects.toThrow("Choose the states");
  expect(await s.enable(30)).toMatchObject({ autoCloseAfterDays: 30, autoCloseToStateId: s.done.id });
}));

test.concurrent("the daily run closes idle items as the system, names the rule, and tells the assignee; undo puts the state back", async () => withRollback(db, async (tx) => {
  const s = await setup(tx);
  await s.enable(30);
  const id = await s.item("Idle work", s.started.id);
  await tx.insert(workItemAssignees).values({ workItemId: id, userId: s.member.id });
  await applyAutoRules(tx, s.now);
  expect(await s.stateOf(id)).toBe(s.done.id);
  const [change] = await tx.select().from(activities).where(and(eq(activities.entityId, id), eq(activities.source, "auto_rule")));
  expect(change).toMatchObject({ field: "state", oldValue: s.started.id, newValue: s.done.id, actorId: s.admin.id });
  expect(JSON.parse(change!.reason!)).toEqual({ autoRule: "idle_close", days: 30, from: "In Progress", to: "Done" });
  const queued = (await tx.select().from(jobs).where(eq(jobs.type, "notify"))).find((job) => (job.payload as { kind?: string; workItemId?: string }).workItemId === id);
  expect(queued).toBeDefined();
  await createJobHandlers(async () => {}).notify(tx, queued!.payload as never, { id: queued!.id, type: "notify" });
  const [note] = await tx.select().from(notifications).where(and(eq(notifications.userId, s.member.id), eq(notifications.kind, "auto_rule")));
  expect(note).toMatchObject({ workItemId: id, detail: change!.reason });
  // The inbox row names the work item like every other kind, so the web app can link to it.
  const inbox = await createNotificationActions(tx).listNotifications.handler({ userId: s.member.id }, { workspaceId: s.workspace.id });
  expect(inbox.notifications.find((row) => row.kind === "auto_rule")).toMatchObject({ workItemId: id, displayId: "APP-1", workItemTitle: "Idle work", detail: change!.reason });
  // Undo: the change must still be the item's latest, and puts the previous state back as a person's change.
  await s.rules.undoAutoRuleChange.handler({ userId: s.member.id }, { activityId: change!.id });
  expect(await s.stateOf(id)).toBe(s.started.id);
  await expect(s.rules.undoAutoRuleChange.handler({ userId: s.member.id }, { activityId: change!.id })).rejects.toThrow("later change");
}));

test.concurrent("undo is refused once the item has moved again since the automatic change", async () => withRollback(db, async (tx) => {
  const s = await setup(tx);
  await s.enable(30);
  const id = await s.item("Idle work", s.started.id);
  await applyAutoRules(tx, s.now);
  const [change] = await tx.select().from(activities).where(and(eq(activities.entityId, id), eq(activities.source, "auto_rule")));
  await tx.update(workItems).set({ stateId: s.cancelled.id }).where(eq(workItems.id, id));
  await expect(s.rules.undoAutoRuleChange.handler({ userId: s.member.id }, { activityId: change!.id })).rejects.toThrow("moved after");
  expect(await s.stateOf(id)).toBe(s.cancelled.id);
}));

test.concurrent("items with recent activity, a recent comment, a recent Run, or an open Run are not closed", async () => withRollback(db, async (tx) => {
  const s = await setup(tx);
  await s.enable(30);
  const idle = await s.item("Idle", s.started.id);
  const touched = await s.item("Touched recently", s.started.id);
  const commented = await s.item("Commented recently", s.started.id);
  const ran = await s.item("Ran recently", s.started.id);
  const running = await s.item("Run still open", s.started.id);
  const recent = new Date(s.now.getTime() - 5 * dayMs);
  await tx.update(workItems).set({ updatedAt: recent }).where(eq(workItems.id, touched));
  await tx.insert(comments).values({ workspaceId: s.workspace.id, projectId: s.project.id, workItemId: commented, authorId: s.member.id, body: {}, bodyText: "Looking", createdAt: recent });
  await tx.insert(runs).values({ workspaceId: s.workspace.id, projectId: s.project.id, workItemId: ran, originatorId: s.member.id, status: "completed", createdAt: recent });
  await tx.insert(runs).values({ workspaceId: s.workspace.id, projectId: s.project.id, workItemId: running, originatorId: s.member.id, status: "running" });
  await applyAutoRules(tx, s.now);
  expect(await s.stateOf(idle)).toBe(s.done.id);
  for (const id of [touched, commented, ran, running]) expect(await s.stateOf(id)).toBe(s.started.id);
}));

test.concurrent("the daily run archives done items once they were done long enough, and undo restores them", async () => withRollback(db, async (tx) => {
  const s = await setup(tx);
  await s.enable(null, 30);
  const old = await s.item("Finished long ago", s.done.id);
  const fresh = await s.item("Finished last week", s.done.id);
  await tx.update(workItems).set({ completedAt: new Date(s.now.getTime() - 5 * dayMs) }).where(eq(workItems.id, fresh));
  await tx.update(workItems).set({ completedAt: new Date(Date.now() - 1 * dayMs) }).where(eq(workItems.id, old));
  await applyAutoRules(tx, s.now);
  const [archivedOld] = await tx.select().from(workItems).where(eq(workItems.id, old));
  const [archivedFresh] = await tx.select().from(workItems).where(eq(workItems.id, fresh));
  expect(archivedOld!.archivedAt).not.toBeNull();
  expect(archivedFresh!.archivedAt).toBeNull();
  const [change] = await tx.select().from(activities).where(and(eq(activities.entityId, old), eq(activities.source, "auto_rule")));
  expect(change).toMatchObject({ field: "archived" });
  expect(JSON.parse(change!.reason!)).toEqual({ autoRule: "done_archive", days: 30 });
  await s.rules.undoAutoRuleChange.handler({ userId: s.member.id }, { activityId: change!.id });
  const [restored] = await tx.select().from(workItems).where(eq(workItems.id, old));
  expect(restored!.archivedAt).toBeNull();
}));

test.concurrent("a daily run is queued once per calendar day, and a cancelled item never counts as done for archive", async () => withRollback(db, async (tx) => {
  const s = await setup(tx);
  const concurrent = await Promise.all([scheduleAutoRules(tx, new Date()), scheduleAutoRules(tx, new Date())]);
  expect(concurrent.filter(Boolean)).toHaveLength(1);
  const first = concurrent.find(Boolean)!;
  expect(await scheduleAutoRules(tx, new Date())).toBeNull();
  await tx.update(jobs).set({ status: "succeeded", finishedAt: new Date() }).where(eq(jobs.id, first!));
  expect(await scheduleAutoRules(tx, new Date())).toBeNull();
  const cancelled = await s.item("Dropped", s.cancelled.id);
  await s.enable(null, 1);
  await tx.update(workItems).set({ completedAt: new Date(s.now.getTime() - 10 * dayMs) }).where(eq(workItems.id, cancelled));
  await applyAutoRules(tx, s.now);
  expect((await tx.select().from(workItems).where(eq(workItems.id, cancelled)))[0]!.archivedAt).toBeNull();
}));

test("an Agent never reads, changes, or undoes automatic rules, whatever its grants", () => {
  const everything = { allowProjectActions: true, allowMemberActions: true, allowFeatureActions: true, allowExportActions: true };
  for (const action of ["get_auto_rules", "preview_auto_rules", "update_auto_rules", "undo_auto_rule_change"]) expect(agentMayUseAction(action, everything)).toBe(false);
});

const dayIso = (offset: number) => new Date(Date.now() + offset * dayMs).toISOString().slice(0, 10);

test.concurrent("an idle item in a Cycle that has not ended is not closed; one in an ended Cycle is", async () => withRollback(db, async (tx) => {
  const s = await setup(tx);
  await s.enable(30);
  const cycles = createCycleActions(tx);
  const as = { userId: s.admin.id };
  const open = await cycles.createCycle.handler(as, { projectId: s.project.id, name: "Now", startDate: dayIso(-1), endDate: dayIso(6) });
  const over = await cycles.createCycle.handler(as, { projectId: s.project.id, name: "Then", startDate: dayIso(-20), endDate: dayIso(-10) });
  const inOpen = await s.item("In open Cycle", s.started.id);
  const inOver = await s.item("In ended Cycle", s.started.id);
  await cycles.addCycleItems.handler(as, { cycleId: open.id, workItemIds: [inOpen] });
  await tx.execute(`insert into cycle_items (work_item_id, cycle_id, workspace_id, project_id) select '${inOver}', '${over.id}', workspace_id, id from projects where id = '${s.project.id}'` as never);
  const preview = await s.rules.previewAutoRules.handler(as, { projectId: s.project.id, autoCloseAfterDays: 30, autoCloseFromStateIds: [s.started.id], autoCloseToStateId: s.done.id, autoArchiveAfterDays: null });
  await applyAutoRules(tx, s.now);
  expect(await s.stateOf(inOpen)).toBe(s.started.id);
  expect(await s.stateOf(inOver)).toBe(s.done.id);
  expect(preview.toClose).toBe(0);
}));

test.concurrent("undo of an automatic close is refused while the item is archived, and works after it is restored", async () => withRollback(db, async (tx) => {
  const s = await setup(tx);
  await s.enable(30);
  const id = await s.item("Idle work", s.started.id);
  await applyAutoRules(tx, s.now);
  const [change] = await tx.select().from(activities).where(and(eq(activities.entityId, id), eq(activities.source, "auto_rule")));
  await s.archive.archiveWorkItem.handler({ userId: s.member.id }, { workItemId: id });
  await expect(s.rules.undoAutoRuleChange.handler({ userId: s.member.id }, { activityId: change!.id })).rejects.toThrow("Restore the work item first");
  expect(await s.stateOf(id)).toBe(s.done.id);
  await s.archive.restoreWorkItem.handler({ userId: s.member.id }, { workItemId: id });
  await s.rules.undoAutoRuleChange.handler({ userId: s.member.id }, { activityId: change!.id });
  expect(await s.stateOf(id)).toBe(s.started.id);
}));

test("the daily run is due at 02:00 Bangkok time: the most recent such instant at or before now", () => {
  expect(autoRulesRunHour).toBe(2);
  expect(autoRulesTimezone).toBe("Asia/Bangkok");
  // 2026-11-14 00:00 UTC is 07:00 in Bangkok: today's 02:00 (2026-11-13 19:00 UTC) has passed.
  expect(autoRulesDueAt(new Date("2026-11-14T00:00:00Z")).toISOString()).toBe("2026-11-13T19:00:00.000Z");
  // One minute before 02:00 Bangkok the due time is still the day before.
  expect(autoRulesDueAt(new Date("2026-11-13T18:59:00Z")).toISOString()).toBe("2026-11-12T19:00:00.000Z");
  expect(autoRulesDueAt(new Date("2026-11-13T19:00:00Z")).toISOString()).toBe("2026-11-13T19:00:00.000Z");
});

test.concurrent("a job queued yesterday does not stop today's run, and one queued since the due time does", async () => withRollback(db, async (tx) => {
  const now = new Date();
  const yesterday = new Date(autoRulesDueAt(now).getTime() - 3 * 60 * 60 * 1000);
  await tx.insert(jobs).values({ type: "auto_rules", status: "completed", createdAt: yesterday, dedupeKey: null });
  expect(await scheduleAutoRules(tx, now)).not.toBeNull();
  expect(await scheduleAutoRules(tx, now)).toBeNull();
}));

test.concurrent("a legacy auto-rules job created today blocks the date-keyed run", async () => withRollback(db, async (tx) => {
  const now = new Date("2026-11-14T03:00:00.000Z");
  await tx.insert(jobs).values({ type: "auto_rules", status: "failed", createdAt: new Date("2026-11-14T01:00:00.000Z"), dedupeKey: "auto_rules" });
  expect(await scheduleAutoRules(tx, now)).toBeNull();
}));
