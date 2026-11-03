import { afterAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { activities, createDatabase, jobs, recurrences, workItems, type Database } from "@weft/db";
import { createProjectActions, createRecurrenceActions, fireScheduleRecurrence } from "../src";
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
