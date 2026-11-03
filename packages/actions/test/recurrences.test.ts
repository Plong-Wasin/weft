import { afterAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { activities, createDatabase, cycleItems, jobs, projects, recurrences, workItems, workItemStates, type Database } from "@weft/db";
import { notifications, projectMembers } from "@weft/db";
import { createCycleActions, createJobHandlers, createMemberActions, createProjectActions, createRecurrenceActions, fireScheduleRecurrence } from "../src";
import { createMemberFactory, createWorkspaceFactory, withRollback } from "../../db/src/test-helpers";

const { client, db } = createDatabase();
afterAll(async () => client.end());

async function setupCreatorRecurrence(tx: Database) {
  const workspace = await createWorkspaceFactory(tx);
  const admin = await createMemberFactory(tx, workspace.id, "Admin");
  const creator = await createMemberFactory(tx, workspace.id, "Member");
  const projects = createProjectActions(tx);
  const project = await projects.createProject.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Recurring", key: "REC", visibility: "private" });
  await projects.addProjectMember.handler({ userId: admin.id }, { projectId: project.id, userId: creator.id, role: "Member" });
  const recurrence = await createRecurrenceActions(tx).createRecurrence.handler({ userId: creator.id }, {
    projectId: project.id, name: "Weekly report", template: { title: "Write the report" },
    schedule: { unit: "day", interval: 1, time: "09:00", timezone: "UTC", anchorDate: "2026-11-01" },
  });
  return { workspace, admin, creator, project, recurrence: recurrence!, projects };
}

test.concurrent("removing a Recurrence creator from a project pauses it and queues a notice for every project Admin", async () => {
  await withRollback(db, async (tx: Database) => {
    const s = await setupCreatorRecurrence(tx);
    const secondAdmin = await createMemberFactory(tx, s.workspace.id, "Member");
    await s.projects.addProjectMember.handler({ userId: s.admin.id }, { projectId: s.project.id, userId: secondAdmin.id, role: "Admin" });
    await s.projects.removeProjectMember.handler({ userId: s.admin.id }, { projectId: s.project.id, userId: s.creator.id });
    const [row] = await tx.select().from(recurrences).where(eq(recurrences.id, s.recurrence.id));
    expect(row!.status).toBe("paused");
    const [notice] = await tx.select().from(jobs).where(eq(jobs.type, "notify"));
    const payload = notice!.payload as { kind: string; recurrenceId: string; recurrenceName: string; reason: string; recipientIds: string[] };
    expect(payload).toMatchObject({ kind: "recurrence_paused", recurrenceId: s.recurrence.id, recurrenceName: "Weekly report", reason: "creator was removed from the project" });
    expect(payload.recipientIds.sort()).toEqual([s.admin.id, secondAdmin.id].sort());
    await createJobHandlers(async () => {}).notify(tx, payload, { id: notice!.id, type: notice!.type });
    const received = await tx.select().from(notifications).where(eq(notifications.recurrenceId, s.recurrence.id));
    expect(received.map((notification) => notification.userId).sort()).toEqual([s.admin.id, secondAdmin.id].sort());
    expect(received[0]?.detail).toContain("Weekly report: creator was removed from the project");
  });
});

test.concurrent("removing a Recurrence creator from the workspace pauses it and notifies project Admins", async () => {
  await withRollback(db, async (tx: Database) => {
    const s = await setupCreatorRecurrence(tx);
    await createMemberActions(tx).removeMember.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id, userId: s.creator.id });
    const [row] = await tx.select().from(recurrences).where(eq(recurrences.id, s.recurrence.id));
    expect(row!.status).toBe("paused");
    const [notice] = await tx.select().from(jobs).where(eq(jobs.type, "notify"));
    expect(notice!.payload).toMatchObject({ kind: "recurrence_paused", recurrenceId: s.recurrence.id, reason: "creator was removed from the workspace", recipientIds: [s.admin.id] });
  });
});

test.concurrent("a due Recurrence whose creator lost project write access pauses and notifies admins without creating work", async () => {
  await withRollback(db, async (tx: Database) => {
    const s = await setupCreatorRecurrence(tx);
    await tx.delete(projectMembers).where(eq(projectMembers.userId, s.creator.id));
    await fireScheduleRecurrence(tx, { recurrenceId: s.recurrence.id, now: new Date(s.recurrence.nextRunAt.getTime() + 60_000) });
    const [row] = await tx.select().from(recurrences).where(eq(recurrences.id, s.recurrence.id));
    expect(row!.status).toBe("paused");
    expect(await tx.select().from(workItems).where(eq(workItems.projectId, s.project.id))).toHaveLength(0);
    const [notice] = await tx.select().from(jobs).where(eq(jobs.type, "notify"));
    expect(notice!.payload).toMatchObject({ kind: "recurrence_paused", recurrenceId: s.recurrence.id, recipientIds: [s.admin.id] });
  });
});

test.concurrent("a due Recurrence creates one Work item as its creator and records provenance, even after downtime", async () => {
  await withRollback(db, async (tx: Database) => {
    const workspace = await createWorkspaceFactory(tx);
    const creator = await createMemberFactory(tx, workspace.id, "Member");
    const project = await createProjectActions(tx).createProject.handler({ userId: creator.id }, { workspaceId: workspace.id, name: "Recurring", key: "REC", visibility: "private" });
    const actions = createRecurrenceActions(tx);
    const recurrence = await actions.createRecurrence.handler({ userId: creator.id }, { projectId: project.id, name: "Weekly report", template: { title: "Write the report", description: { type: "doc", content: [] } }, schedule: { unit: "day", interval: 1, time: "09:00", timezone: "UTC", anchorDate: "2026-11-01" } });
    expect(await actions.getRecurrence.handler({ userId: creator.id }, { recurrenceId: recurrence!.id })).toMatchObject({ name: "Weekly report" });
    expect(await actions.listRecurrences.handler({ userId: creator.id }, { projectId: project.id })).toHaveLength(1);
    const now = new Date(recurrence!.nextRunAt.getTime() + 4 * 86_400_000);
    await fireScheduleRecurrence(tx, { recurrenceId: recurrence!.id, now });
    await fireScheduleRecurrence(tx, { recurrenceId: recurrence!.id, now });
    const created = await tx.select().from(workItems).where(eq(workItems.projectId, project.id));
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ title: "Write the report", createdBy: creator.id });
    const provenance = await tx.select().from(activities).where(and(eq(activities.entityId, created[0]!.id), eq(activities.field, "recurrence_created")));
    expect(provenance[0]?.newValue).toEqual({ recurrenceId: recurrence!.id, name: "Weekly report" });
    const [advanced] = await tx.select().from(recurrences).where(eq(recurrences.id, recurrence!.id));
    expect(advanced!.nextRunAt.getTime()).toBeGreaterThan(now.getTime());
    expect(await tx.select().from(jobs).where(eq(jobs.type, "schedule_recurrence"))).toHaveLength(2);
  });
});

test.concurrent("a generated Work item copies template fields and degrades invalid references with a warning", async () => {
  await withRollback(db, async (tx: Database) => {
    const workspace = await createWorkspaceFactory(tx);
    const creator = await createMemberFactory(tx, workspace.id, "Member");
    const project = await createProjectActions(tx).createProject.handler({ userId: creator.id }, { workspaceId: workspace.id, name: "Template", key: "TMP", visibility: "private" });
    const [state] = await tx.select().from(workItemStates).where(eq(workItemStates.projectId, project.id));
    const recurrence = await createRecurrenceActions(tx).createRecurrence.handler({ userId: creator.id }, {
      projectId: project.id, name: "Full template",
      template: { title: "Review", description: { type: "doc", content: [] }, priority: "high", stateId: crypto.randomUUID(), assigneeIds: [crypto.randomUUID()], labelIds: [crypto.randomUUID()], estimatePointId: crypto.randomUUID(), moduleIds: [crypto.randomUUID()], parentId: crypto.randomUUID(), dueDateOffsetDays: 3, addToActiveCycle: true },
      schedule: { unit: "day", interval: 1, time: "09:00", timezone: "UTC", anchorDate: "2026-11-01" },
    } as never);
    const firedAt = new Date(recurrence!.nextRunAt.getTime() + 86_400_000);
    const cycleDay = firedAt.toISOString().slice(0, 10);
    const cycle = await createCycleActions(tx).createCycle.handler({ userId: creator.id }, { projectId: project.id, name: "Current", startDate: cycleDay, endDate: cycleDay });
    const [stored] = await tx.select().from(recurrences).where(eq(recurrences.id, recurrence!.id));
    expect(stored!.template).toMatchObject({ stateId: expect.any(String), moduleIds: expect.any(Array), dueDateOffsetDays: 3 });
    await fireScheduleRecurrence(tx, { recurrenceId: recurrence!.id, now: firedAt });
    const [item] = await tx.select().from(workItems).where(eq(workItems.projectId, project.id));
    expect(item).toMatchObject({ title: "Review", priority: "high", stateId: state!.id });
    expect(item!.dueDate).toBe(new Date(Date.UTC(firedAt.getUTCFullYear(), firedAt.getUTCMonth(), firedAt.getUTCDate() + 3)).toISOString().slice(0, 10));
    expect(await tx.select().from(cycleItems).where(eq(cycleItems.workItemId, item!.id))).toMatchObject([{ cycleId: cycle.id }]);
    const [after] = await tx.select().from(recurrences).where(eq(recurrences.id, recurrence!.id));
    expect(after).toHaveProperty("lastWarning");
    expect(after!.lastWarning).toContain("state");
    expect(after!.lastWarning).toContain("assignee");
    expect(after!.lastWarning).toContain("label");
    expect(after!.lastWarning).toContain("Module");
  });
});

test.concurrent("members can edit, pause, resume, run now, and delete a Recurrence without changing past work", async () => {
  await withRollback(db, async (tx: Database) => {
    const workspace = await createWorkspaceFactory(tx);
    const member = await createMemberFactory(tx, workspace.id, "Member");
    const project = await createProjectActions(tx).createProject.handler({ userId: member.id }, { workspaceId: workspace.id, name: "Lifecycle", key: "LIFE", visibility: "private" });
    const actions = createRecurrenceActions(tx);
    const recurrence = await actions.createRecurrence.handler({ userId: member.id }, { projectId: project.id, name: "Original", template: { title: "Old title" }, schedule: { unit: "day", interval: 1, time: "09:00", timezone: "UTC", anchorDate: "2026-11-01" } });
    const oldNextRunAt = recurrence!.nextRunAt;
    await actions.runRecurrenceNow.handler({ userId: member.id }, { recurrenceId: recurrence!.id });
    await actions.updateRecurrence.handler({ userId: member.id }, { recurrenceId: recurrence!.id, name: "Edited", template: { title: "New title" } });
    await actions.pauseRecurrence.handler({ userId: member.id }, { recurrenceId: recurrence!.id });
    await fireScheduleRecurrence(tx, { recurrenceId: recurrence!.id, now: new Date(oldNextRunAt.getTime() + 86_400_000) });
    expect((await tx.select().from(workItems).where(eq(workItems.projectId, project.id))).map((item) => item.title)).toEqual(["Old title"]);
    const resumed = await actions.resumeRecurrence.handler({ userId: member.id }, { recurrenceId: recurrence!.id });
    expect(resumed!.nextRunAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
    const scheduled = resumed!.nextRunAt;
    await actions.runRecurrenceNow.handler({ userId: member.id }, { recurrenceId: recurrence!.id });
    expect((await actions.getRecurrence.handler({ userId: member.id }, { recurrenceId: recurrence!.id })).nextRunAt).toEqual(scheduled);
    const items = await tx.select().from(workItems).where(eq(workItems.projectId, project.id));
    expect(items).toHaveLength(2);
    expect(items.map((item) => item.title).sort()).toEqual(["New title", "Old title"]);
    await actions.deleteRecurrence.handler({ userId: member.id }, { recurrenceId: recurrence!.id });
    expect(await tx.select().from(workItems).where(eq(workItems.projectId, project.id))).toHaveLength(2);
    await expect(actions.getRecurrence.handler({ userId: member.id }, { recurrenceId: recurrence!.id })).rejects.toMatchObject({ status: 404 });
  });
});

test.concurrent("end dates stop future runs and every lifecycle write denies Guests", async () => {
  await withRollback(db, async (tx: Database) => {
    const workspace = await createWorkspaceFactory(tx);
    const member = await createMemberFactory(tx, workspace.id, "Member");
    const guest = await createMemberFactory(tx, workspace.id, "Guest");
    const project = await createProjectActions(tx).createProject.handler({ userId: member.id }, { workspaceId: workspace.id, name: "End date", key: "ENDD", visibility: "public" });
    const actions = createRecurrenceActions(tx);
    const recurrence = await actions.createRecurrence.handler({ userId: member.id }, { projectId: project.id, name: "Campaign", template: { title: "Campaign task" }, schedule: { unit: "day", interval: 1, time: "09:00", timezone: "UTC", anchorDate: "2026-11-01" }, endDate: "2026-11-02" });
    await expect(actions.createRecurrence.handler({ userId: guest.id }, { projectId: project.id, name: "No", template: { title: "No" }, schedule: { unit: "day", interval: 1, time: "09:00", timezone: "UTC", anchorDate: "2026-11-01" } })).rejects.toMatchObject({ status: 403 });
    await fireScheduleRecurrence(tx, { recurrenceId: recurrence!.id, now: new Date("2026-11-04T12:00:00Z") });
    expect((await actions.getRecurrence.handler({ userId: member.id }, { recurrenceId: recurrence!.id })).status).toBe("ended");
    expect(await tx.select().from(workItems).where(eq(workItems.projectId, project.id))).toHaveLength(0);
    await expect(actions.updateRecurrence.handler({ userId: guest.id }, { recurrenceId: recurrence!.id, name: "No" })).rejects.toMatchObject({ status: 403 });
    await expect(actions.pauseRecurrence.handler({ userId: guest.id }, { recurrenceId: recurrence!.id })).rejects.toMatchObject({ status: 403 });
    await expect(actions.resumeRecurrence.handler({ userId: guest.id }, { recurrenceId: recurrence!.id })).rejects.toMatchObject({ status: 403 });
    await expect(actions.deleteRecurrence.handler({ userId: guest.id }, { recurrenceId: recurrence!.id })).rejects.toMatchObject({ status: 403 });
    await expect(actions.runRecurrenceNow.handler({ userId: guest.id }, { recurrenceId: recurrence!.id })).rejects.toMatchObject({ status: 403 });
    await tx.delete(projects).where(eq(projects.id, project.id));
    expect(await tx.select().from(recurrences).where(eq(recurrences.id, recurrence!.id))).toHaveLength(0);
  });
});

test.concurrent("a due Recurrence in an archived project pauses with a reason and does not die silently", async () => {
  await withRollback(db, async (tx: Database) => {
    const s = await setupCreatorRecurrence(tx);
    await s.projects.archiveProject.handler({ userId: s.admin.id }, { projectId: s.project.id });
    await fireScheduleRecurrence(tx, { recurrenceId: s.recurrence.id, now: new Date(s.recurrence.nextRunAt.getTime() + 60_000) });
    const [row] = await tx.select().from(recurrences).where(eq(recurrences.id, s.recurrence.id));
    expect(row!.status).toBe("paused");
    expect(row!.pausedReason).toBeTruthy();
    expect(await tx.select().from(workItems).where(eq(workItems.projectId, s.project.id))).toHaveLength(0);
    expect((await tx.select().from(jobs).where(eq(jobs.type, "notify"))).length).toBe(1);
  });
});

test.concurrent("demoting a Recurrence creator to workspace Guest pauses it", async () => {
  await withRollback(db, async (tx: Database) => {
    const s = await setupCreatorRecurrence(tx);
    await createMemberActions(tx).changeMemberRole.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id, userId: s.creator.id, role: "Guest" });
    const [row] = await tx.select().from(recurrences).where(eq(recurrences.id, s.recurrence.id));
    expect(row!.status).toBe("paused");
  });
});

test.concurrent("moving the end date forward revives an ended Recurrence and an unchanged schedule keeps its next run", async () => {
  await withRollback(db, async (tx: Database) => {
    const s = await setupCreatorRecurrence(tx);
    const actions = createRecurrenceActions(tx);
    const ended = await actions.updateRecurrence.handler({ userId: s.creator.id }, { recurrenceId: s.recurrence.id, endDate: "2020-01-01" });
    expect(ended.status).toBe("ended");
    const revived = await actions.updateRecurrence.handler({ userId: s.creator.id }, { recurrenceId: s.recurrence.id, endDate: null });
    expect(revived.status).toBe("active");
    expect(revived.nextRunAt.getTime()).toBeGreaterThan(Date.now());
    const renamed = await actions.updateRecurrence.handler({ userId: s.creator.id }, { recurrenceId: s.recurrence.id, name: "Renamed" });
    expect(renamed.nextRunAt.getTime()).toBe(revived.nextRunAt.getTime());
  });
});
