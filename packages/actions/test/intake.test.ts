import { afterAll, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { activities, createDatabase, cycleItems, intakeItems, notifications, outboundWebhookDeliveries, workItemPropertyValues, workItemStates, workItems, workItemRelations, type Database } from "@weft/db";
import {
  createCommentActions, createCycleActions, createIntakeActions, createOutboundWebhookActions, createWorkItemTypeActions, createJobHandlers, createNotificationActions, createProjectActions, createRelationActions,
  createSearchActions, createWorkItemActions, effectiveOutcome,
} from "../src";
import { createMemberFactory, createWorkspaceFactory, withRollback } from "../../db/src/test-helpers";

const { client, db } = createDatabase();
afterAll(async () => client.end());

async function setup(transaction: Database, visibility: "public" | "private" = "public") {
  const workspace = await createWorkspaceFactory(transaction);
  const admin = await createMemberFactory(transaction, workspace.id, "Admin");
  const member = await createMemberFactory(transaction, workspace.id, "Member");
  const guest = await createMemberFactory(transaction, workspace.id, "Guest");
  const outsider = await createMemberFactory(transaction, workspace.id, "Member");
  const projects = createProjectActions(transaction);
  const project = await projects.createProject.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Mobile", key: "MOB", visibility });
  await projects.addProjectMember.handler({ userId: admin.id }, { projectId: project.id, userId: member.id, role: "Member" });
  await projects.addProjectMember.handler({ userId: admin.id }, { projectId: project.id, userId: guest.id, role: "Guest" });
  const work = createWorkItemActions(transaction);
  const intake = createIntakeActions(transaction);
  const submit = (userId: string, title = "Please add dark mode") => intake.submitIntakeItem.handler({ userId }, { projectId: project.id, title });
  return { workspace, admin, member, guest, outsider, projects, project, work, intake, submit, transaction };
}

const triageStates = (transaction: Database, projectId: string) => transaction.select().from(workItemStates).where(and(eq(workItemStates.projectId, projectId), eq(workItemStates.group, "triage")));

test.concurrent("a new project has exactly one Triage state, hidden from list_states", async () => {
  await withRollback(db, async (transaction) => {
    const { project, work, admin } = await setup(transaction);
    expect((await triageStates(transaction, project.id)).map((state) => state.name)).toEqual(["Triage"]);
    expect((await work.listStates.handler({ userId: admin.id }, { projectId: project.id })).map((state) => state.name)).toEqual(["Backlog", "Todo", "In Progress", "Done", "Cancelled"]);
  });
});

test.concurrent("Admin, Member and Guest submit; the work item sits in Triage as pending", async () => {
  await withRollback(db, async (transaction) => {
    const { admin, member, guest, submit, project, intake } = await setup(transaction);
    for (const user of [admin, member, guest]) {
      const created = await submit(user.id, `from ${user.id}`);
      expect(created).toMatchObject({ outcome: "pending", createdBy: user.id, projectId: project.id });
    }
    const [triage] = await triageStates(transaction, project.id);
    const rows = await transaction.select().from(workItems).where(eq(workItems.stateId, triage!.id));
    expect(rows).toHaveLength(3);
    expect((await intake.listIntakeItems.handler({ userId: member.id }, { projectId: project.id, outcome: "pending" }))).toHaveLength(3);
    const [first] = rows;
    const [log] = await transaction.select().from(activities).where(and(eq(activities.entityId, first!.id), eq(activities.field, "created")));
    expect(log).toMatchObject({ entityType: "work_item", source: "ui" });
  });
});

test.concurrent("a person who cannot see a private project cannot submit or list", async () => {
  await withRollback(db, async (transaction) => {
    const { outsider, project, intake } = await setup(transaction, "private");
    await expect(intake.submitIntakeItem.handler({ userId: outsider.id }, { projectId: project.id, title: "x" })).rejects.toMatchObject({ status: 404 });
    await expect(intake.listIntakeItems.handler({ userId: outsider.id }, { projectId: project.id, outcome: "pending" })).rejects.toMatchObject({ status: 404 });
  });
});

test.concurrent("accept moves the item to the first Backlog state, notifies the submitter, and logs intake_accepted", async () => {
  await withRollback(db, async (transaction) => {
    const { member, guest, admin, submit, intake, work, project, workspace } = await setup(transaction);
    const created = await submit(guest.id);
    const accepted = await intake.acceptIntakeItem.handler({ userId: member.id }, { intakeItemId: created.id });
    expect(accepted.outcome).toBe("accepted");
    const states = await work.listStates.handler({ userId: admin.id }, { projectId: project.id });
    const fetched = await work.getWorkItem.handler({ userId: guest.id }, { workspaceId: workspace.id, displayId: created.displayId });
    expect(fetched.stateId).toBe(states.find((state) => state.group === "backlog")!.id);
    expect((await work.listWorkItems.handler({ userId: guest.id }, { projectId: project.id })).map((row) => row.id)).toEqual([created.workItemId]);
    const [entry] = await transaction.select().from(activities).where(and(eq(activities.entityId, created.workItemId), eq(activities.field, "intake_accepted")));
    expect(entry).toMatchObject({ actorId: member.id, source: "ui" });
    const jobs = await transaction.execute<{ payload: { kind: string; recipientIds: string[] } }>(sql`select payload from jobs where type = 'notify'`);
    expect([...jobs].map((job) => [job.payload.kind, job.payload.recipientIds])).toEqual([["intake_accepted", [guest.id]]]);
  });
});

test.concurrent("reject, snooze and duplicate leave the item in Triage, and no Declined state or Relation appears", async () => {
  await withRollback(db, async (transaction) => {
    const { member, guest, submit, intake, work, project } = await setup(transaction);
    const original = await work.createWorkItem.handler({ userId: member.id }, { projectId: project.id, title: "Original" });
    const [a, b, c] = [await submit(guest.id, "a"), await submit(guest.id, "b"), await submit(guest.id, "c")];
    expect((await intake.rejectIntakeItem.handler({ userId: member.id }, { intakeItemId: a.id })).outcome).toBe("rejected");
    const till = new Date(Date.now() + 3_600_000).toISOString();
    expect(await intake.snoozeIntakeItem.handler({ userId: member.id }, { intakeItemId: b.id, snoozedTill: till })).toMatchObject({ outcome: "snoozed", snoozedTill: till });
    expect(await intake.duplicateIntakeItem.handler({ userId: member.id }, { intakeItemId: c.id, duplicateTo: original.id })).toMatchObject({ outcome: "duplicate", duplicateTo: original.id, duplicateToDisplayId: "MOB-1" });
    const [triage] = await triageStates(transaction, project.id);
    for (const item of [a, b, c]) expect((await transaction.select().from(workItems).where(eq(workItems.id, item.workItemId)))[0]!.stateId).toBe(triage!.id);
    expect(await transaction.select().from(workItemRelations)).toHaveLength(0);
    const names = (await transaction.select().from(workItemStates).where(eq(workItemStates.projectId, project.id))).map((state) => state.name);
    expect(names).not.toContain("Declined");
    for (const field of ["intake_rejected", "intake_snoozed", "intake_duplicate"]) {
      expect(await transaction.select().from(activities).where(and(eq(activities.projectId, project.id), eq(activities.field, field)))).toHaveLength(1);
    }
    await expect(intake.acceptIntakeItem.handler({ userId: member.id }, { intakeItemId: a.id })).rejects.toMatchObject({ status: 400 });
  });
});

test.concurrent("duplicateTo must be another normal work item of the same project", async () => {
  await withRollback(db, async (transaction) => {
    const { member, submit, intake } = await setup(transaction);
    const one = await submit(member.id, "one");
    const two = await submit(member.id, "two");
    await expect(intake.duplicateIntakeItem.handler({ userId: member.id }, { intakeItemId: one.id, duplicateTo: one.workItemId })).rejects.toMatchObject({ status: 400 });
    await expect(intake.duplicateIntakeItem.handler({ userId: member.id }, { intakeItemId: one.id, duplicateTo: two.workItemId })).rejects.toMatchObject({ status: 400 });
  });
});

test.concurrent("a snoozed item leaves the pending list until snoozed_till, then returns as pending", async () => {
  await withRollback(db, async (transaction) => {
    const { member, submit, intake, project } = await setup(transaction);
    const created = await submit(member.id);
    await intake.snoozeIntakeItem.handler({ userId: member.id }, { intakeItemId: created.id, snoozedTill: new Date(Date.now() + 3_600_000).toISOString() });
    const list = (outcome: "pending" | "snoozed") => intake.listIntakeItems.handler({ userId: member.id }, { projectId: project.id, outcome });
    expect(await list("pending")).toHaveLength(0);
    expect(await list("snoozed")).toHaveLength(1);
    await transaction.update(intakeItems).set({ snoozedTill: new Date(Date.now() - 1000) }).where(eq(intakeItems.id, created.id));
    expect(await list("snoozed")).toHaveLength(0);
    const [back] = await list("pending");
    expect(back).toMatchObject({ id: created.id, outcome: "pending" });
    expect(effectiveOutcome({ outcome: "snoozed", snoozedTill: new Date(0) })).toBe("pending");
    // A woken item can be decided again.
    expect((await intake.acceptIntakeItem.handler({ userId: member.id }, { intakeItemId: created.id })).outcome).toBe("accepted");
  });
});

test.concurrent("snooze needs a future date", async () => {
  await withRollback(db, async (transaction) => {
    const { member, submit, intake } = await setup(transaction);
    const created = await submit(member.id);
    for (const snoozedTill of ["nope", new Date(Date.now() - 1000).toISOString()]) {
      await expect(intake.snoozeIntakeItem.handler({ userId: member.id }, { intakeItemId: created.id, snoozedTill })).rejects.toMatchObject({ status: 400 });
    }
  });
});

test.concurrent("a Guest and a non-member cannot decide; a Guest can read", async () => {
  await withRollback(db, async (transaction) => {
    const { guest, submit, intake, member } = await setup(transaction);
    const created = await submit(member.id);
    await expect(intake.acceptIntakeItem.handler({ userId: guest.id }, { intakeItemId: created.id })).rejects.toMatchObject({ status: 403 });
    await expect(intake.rejectIntakeItem.handler({ userId: guest.id }, { intakeItemId: created.id })).rejects.toMatchObject({ status: 403 });
    await expect(intake.snoozeIntakeItem.handler({ userId: guest.id }, { intakeItemId: created.id, snoozedTill: new Date(Date.now() + 1e6).toISOString() })).rejects.toMatchObject({ status: 403 });
    await expect(intake.duplicateIntakeItem.handler({ userId: guest.id }, { intakeItemId: created.id, duplicateTo: created.workItemId })).rejects.toMatchObject({ status: 403 });
  });
});

test.concurrent("only a project Admin or the creator edits an Intake item's content", async () => {
  await withRollback(db, async (transaction) => {
    const { member, guest, admin, submit, intake, projects, project, workspace } = await setup(transaction);
    const other = await createMemberFactory(transaction, workspace.id, "Member");
    await projects.addProjectMember.handler({ userId: admin.id }, { projectId: project.id, userId: other.id, role: "Member" });
    const created = await submit(guest.id, "typo");
    expect((await intake.updateIntakeItem.handler({ userId: guest.id }, { intakeItemId: created.id, title: "fixed" })).title).toBe("fixed");
    expect((await intake.updateIntakeItem.handler({ userId: admin.id }, { intakeItemId: created.id, title: "admin edit" })).title).toBe("admin edit");
    await expect(intake.updateIntakeItem.handler({ userId: member.id }, { intakeItemId: created.id, title: "nope" })).rejects.toMatchObject({ status: 403 });
    await expect(intake.updateIntakeItem.handler({ userId: other.id }, { intakeItemId: created.id, title: "nope" })).rejects.toMatchObject({ status: 403 });
    expect(await transaction.select().from(activities).where(and(eq(activities.entityId, created.workItemId), eq(activities.field, "title")))).toHaveLength(2);
    await intake.acceptIntakeItem.handler({ userId: member.id }, { intakeItemId: created.id });
    await expect(intake.updateIntakeItem.handler({ userId: admin.id }, { intakeItemId: created.id, title: "late" })).rejects.toMatchObject({ status: 400 });
  });
});

test.concurrent("a turned-off Intake rejects every Intake Action and keeps its data", async () => {
  await withRollback(db, async (transaction) => {
    const { member, admin, submit, intake, projects, project } = await setup(transaction);
    const created = await submit(member.id);
    await projects.setProjectFeatures.handler({ userId: admin.id }, { projectId: project.id, features: { intake: false } });
    const calls = [
      () => intake.submitIntakeItem.handler({ userId: member.id }, { projectId: project.id, title: "x" }),
      () => intake.listIntakeItems.handler({ userId: member.id }, { projectId: project.id, outcome: "pending" }),
      () => intake.updateIntakeItem.handler({ userId: admin.id }, { intakeItemId: created.id, title: "x" }),
      () => intake.acceptIntakeItem.handler({ userId: admin.id }, { intakeItemId: created.id }),
      () => intake.rejectIntakeItem.handler({ userId: admin.id }, { intakeItemId: created.id }),
      () => intake.snoozeIntakeItem.handler({ userId: admin.id }, { intakeItemId: created.id, snoozedTill: new Date(Date.now() + 1e6).toISOString() }),
      () => intake.duplicateIntakeItem.handler({ userId: admin.id }, { intakeItemId: created.id, duplicateTo: created.workItemId }),
    ];
    for (const call of calls) await expect(call()).rejects.toMatchObject({ status: 400 });
    expect(await transaction.select().from(intakeItems).where(eq(intakeItems.id, created.id))).toHaveLength(1);
  });
});

test.concurrent("the Triage state cannot be added, renamed, reordered, removed, or assigned", async () => {
  await withRollback(db, async (transaction) => {
    const { admin, work, project, member, submit } = await setup(transaction);
    const [triage] = await triageStates(transaction, project.id);
    const actor = { userId: admin.id };
    await expect(work.createState.handler(actor, { projectId: project.id, group: "triage" as never, name: "Second" })).rejects.toMatchObject({ status: 400 });
    await expect(work.updateState.handler(actor, { stateId: triage!.id, name: "Inbox" })).rejects.toMatchObject({ status: 400 });
    await expect(work.deleteState.handler(actor, { stateId: triage!.id })).rejects.toMatchObject({ status: 400 });
    await expect(work.reorderStates.handler(actor, { projectId: project.id, group: "triage" as never, stateIds: [triage!.id] })).rejects.toMatchObject({ status: 400 });
    await expect(work.createWorkItem.handler(actor, { projectId: project.id, title: "x", stateId: triage!.id })).rejects.toMatchObject({ status: 400 });
    const normal = await work.createWorkItem.handler({ userId: member.id }, { projectId: project.id, title: "normal" });
    await expect(work.moveWorkItem.handler({ userId: member.id }, { workItemId: normal.id, stateId: triage!.id } as never)).rejects.toMatchObject({ status: 400 });
    await expect(work.updateWorkItem.handler({ userId: member.id }, { workItemId: normal.id, stateId: triage!.id })).rejects.toMatchObject({ status: 400 });
    await submit(member.id);
    expect(await triageStates(transaction, project.id)).toHaveLength(1);
  });
});

test.concurrent("leak: a Triage work item is absent from every read, for every role", async () => {
  await withRollback(db, async (transaction) => {
    const { admin, member, guest, submit, work, project, workspace } = await setup(transaction);
    const normal = await work.createWorkItem.handler({ userId: member.id }, { projectId: project.id, title: "Needle normal" });
    const hidden = await submit(guest.id, "Needle hidden");
    const parent = await work.createWorkItem.handler({ userId: member.id }, { projectId: project.id, title: "Parent" });
    await transaction.update(workItems).set({ parentId: parent.id }).where(eq(workItems.id, hidden.workItemId));
    const cycles = createCycleActions(transaction);
    const cycle = await cycles.createCycle.handler({ userId: admin.id }, { projectId: project.id, name: "Sprint", startDate: "2030-01-01", endDate: "2030-01-14" });
    await cycles.addCycleItems.handler({ userId: member.id }, { cycleId: cycle.id, workItemIds: [normal.id] });
    // Force the leak path: a stray cycle_items row for the Triage item must still not show.
    await transaction.insert(cycleItems).values({ workItemId: hidden.workItemId, cycleId: cycle.id, workspaceId: workspace.id, projectId: project.id });
    await expect(cycles.addCycleItems.handler({ userId: member.id }, { cycleId: cycle.id, workItemIds: [hidden.workItemId] })).rejects.toMatchObject({ status: 400 });
    const relations = createRelationActions(transaction);
    await transaction.insert(workItemRelations).values({ workspaceId: workspace.id, projectId: project.id, workItemId: normal.id, relatedWorkItemId: hidden.workItemId, type: "relates_to", createdBy: admin.id });
    const comments = createCommentActions(transaction);
    const search = createSearchActions(transaction);
    for (const user of [admin, member, guest]) {
      const as = { userId: user.id };
      const listed = await work.listWorkItems.handler(as, { projectId: project.id });
      expect(listed.map((row) => row.id).sort()).toEqual([normal.id, parent.id].sort());
      expect((await work.listWorkItems.handler(as, { projectId: project.id, cycleId: cycle.id })).map((row) => row.id)).toEqual([normal.id]);
      expect((await search.searchWorkItems.handler(as, { workspaceId: workspace.id, query: "Needle" })).map((row) => row.id)).toEqual([normal.id]);
      expect((await search.searchWorkItems.handler(as, { workspaceId: workspace.id, query: "MOB-2" })).map((row) => row.id)).not.toContain(hidden.workItemId);
      expect((await cycles.getCycle.handler(as, { cycleId: cycle.id })).workItemIds).toEqual([normal.id]);
      expect((await cycles.listCycles.handler(as, { projectId: project.id }))[0]!.itemCount).toBe(1);
      expect(await relations.listWorkItemRelations.handler(as, { workItemId: normal.id })).toHaveLength(0);
      expect((await work.listSubWorkItems.handler(as, { workItemId: parent.id }))).toHaveLength(0);
      for (const read of [
        () => work.getWorkItem.handler(as, { workspaceId: workspace.id, displayId: "MOB-2" }),
        () => work.listWorkItemActivities.handler(as, { workItemId: hidden.workItemId }),
        () => relations.listWorkItemRelations.handler(as, { workItemId: hidden.workItemId }),
        () => comments.listComments.handler(as, { workItemId: hidden.workItemId }),
      ]) await expect(read()).rejects.toMatchObject({ status: 404 });
    }
  });
});

test.concurrent("leak: Triage items cannot be changed or deleted through the normal Actions", async () => {
  await withRollback(db, async (transaction) => {
    const { admin, submit, work, guest } = await setup(transaction);
    const hidden = await submit(guest.id);
    await expect(work.updateWorkItem.handler({ userId: admin.id }, { workItemId: hidden.workItemId, title: "x" })).rejects.toMatchObject({ status: 404 });
    await expect(work.deleteWorkItem.handler({ userId: admin.id }, { workItemId: hidden.workItemId })).rejects.toMatchObject({ status: 404 });
  });
});

test.concurrent("the submitter is notified on accept, reject and duplicate, not on snooze", async () => {
  await withRollback(db, async (transaction) => {
    const { guest, member, workspace, submit, intake, work, project } = await setup(transaction);
    const original = await work.createWorkItem.handler({ userId: member.id }, { projectId: project.id, title: "Original" });
    const till = new Date(Date.now() + 3_600_000).toISOString();
    const [a, b, c, d] = [await submit(guest.id, "a"), await submit(guest.id, "b"), await submit(guest.id, "c"), await submit(guest.id, "d")];
    await intake.acceptIntakeItem.handler({ userId: member.id }, { intakeItemId: a.id });
    await intake.rejectIntakeItem.handler({ userId: member.id }, { intakeItemId: b.id });
    await intake.duplicateIntakeItem.handler({ userId: member.id }, { intakeItemId: c.id, duplicateTo: original.id });
    await intake.snoozeIntakeItem.handler({ userId: member.id }, { intakeItemId: d.id, snoozedTill: till });
    const handlers = createJobHandlers(async () => {});
    const jobs = await transaction.execute<{ id: string; payload: unknown }>(sql`select id, payload from jobs where type = 'notify'`);
    for (const job of jobs) await handlers.notify!(transaction, job.payload as never, { id: job.id } as never);
    const inbox = await createNotificationActions(transaction).listNotifications.handler({ userId: guest.id }, { workspaceId: workspace.id });
    expect(inbox.notifications.map((row) => row.kind).sort()).toEqual(["intake_accepted", "intake_duplicate", "intake_rejected"]);
    expect(inbox.notifications.find((row) => row.kind === "intake_rejected")!.displayId).toBe("MOB-3");
    expect(await transaction.select().from(notifications).where(eq(notifications.userId, member.id))).toHaveLength(0);
  });
});

test.concurrent("a query never returns a work item that is still in Intake", async () => {
  await withRollback(db, async (transaction) => {
    const { workspace, admin, project, work, submit } = await setup(transaction);
    const pending = await submit(admin.id, "Waiting in intake");
    const rows = await work.listWorkItems.handler({ userId: admin.id }, { projectId: project.id, query: 'title ~ "intake"' });
    expect(rows.map((row) => row.id)).not.toContain(pending.workItemId);
    const found = await createSearchActions(transaction).searchWorkItems.handler({ userId: admin.id }, { workspaceId: workspace.id, projectId: project.id, pql: 'title ~ "intake"' });
    expect(JSON.stringify(found)).not.toContain(pending.workItemId);
  });
});

test.concurrent("a Guest lists only their own Intake items; Members and Admins list all", async () => {
  await withRollback(db, async (transaction) => {
    const { guest, member, admin, submit, intake, project } = await setup(transaction);
    await submit(guest.id, "guest item");
    await submit(member.id, "member item");
    const titles = (userId: string) => intake.listIntakeItems.handler({ userId }, { projectId: project.id, outcome: "pending" }).then((rows) => rows.map((row) => row.title).sort());
    expect(await titles(guest.id)).toEqual(["guest item"]);
    expect(await titles(member.id)).toEqual(["guest item", "member item"]);
    expect(await titles(admin.id)).toEqual(["guest item", "member item"]);
  });
});

test.concurrent("an Intake submission gets the default type and property defaults, matches type = Task once accepted, and records work_item.created when webhooks are on", async () => {
  const flag = "WEFT_OUTBOUND_WEBHOOKS_ENABLED";
  const previous = Bun.env[flag];
  Bun.env[flag] = "true";
  try {
    await withRollback(db, async (transaction) => {
      const { admin, member, project, projects, workspace, work, intake, submit } = await setup(transaction);
      await projects.setProjectFeatures.handler({ userId: admin.id }, { projectId: project.id, features: { types: true, intake: true } });
      const types = createWorkItemTypeActions(transaction);
      const [task] = await types.listWorkItemTypes.handler({ userId: admin.id }, { projectId: project.id });
      const note = await types.createCustomProperty.handler({ userId: admin.id }, { projectId: project.id, name: "Channel", kind: "text", typeIds: [task!.id], defaultValue: "web" });
      const hook = await createOutboundWebhookActions(transaction, { allowPrivateNetworks: true }).createOutboundWebhook.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Hook", url: "https://93.184.216.34/hook", events: ["work_item.created"] });
      const submitted = await submit(member.id, "Needs a type");
      const [row] = await transaction.select().from(workItems).where(eq(workItems.id, submitted.workItemId));
      expect(row!.typeId).toBe(task!.id);
      const values = await transaction.select().from(workItemPropertyValues).where(eq(workItemPropertyValues.workItemId, submitted.workItemId));
      expect(values.map((value) => [value.propertyId, value.value])).toEqual([[note.id, "web"]]);
      const deliveries = await transaction.select().from(outboundWebhookDeliveries).where(eq(outboundWebhookDeliveries.webhookId, hook.id));
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]).toMatchObject({ eventType: "work_item.created" });
      expect(JSON.stringify(deliveries[0]!.payload)).toContain("\"type\":\"Task\"");
      await intake.acceptIntakeItem.handler({ userId: admin.id }, { intakeItemId: submitted.id });
      const matched = await work.listWorkItems.handler({ userId: admin.id }, { projectId: project.id, query: "type = Task" });
      expect(matched.map((item) => item.id)).toContain(submitted.workItemId);
    });
  } finally { if (previous === undefined) delete Bun.env[flag]; else Bun.env[flag] = previous; }
});
