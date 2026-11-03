import { afterAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { activities, createDatabase, cycleItems, jobs, recurrences, workItems, workItemStates, type Database } from "@weft/db";
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
