import { afterAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { activities, createDatabase, cycleItems, jobs, projects, recurrences, workItems, workItemStates, type Database } from "@weft/db";
import { createCycleActions, createProjectActions, createRecurrenceActions, fireScheduleRecurrence } from "../src";
import { createMemberFactory, createWorkspaceFactory, withRollback } from "../../db/src/test-helpers";

const { client, db } = createDatabase();
afterAll(async () => client.end());

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
