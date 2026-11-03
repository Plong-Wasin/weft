import { afterAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { activities, createDatabase, jobs, notifications, projectMembers, recurrences, workItems, type Database } from "@weft/db";
import { createJobHandlers, createMemberActions, createProjectActions, createRecurrenceActions, fireScheduleRecurrence } from "../src";
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
