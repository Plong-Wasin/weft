import { afterAll, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { activities, createDatabase, cycleItems, intakeItems, notifications, outboundWebhookDeliveries, runs, workItemAssignees, workItemLabels, workItemPropertyValues, workItemStates, workItems, workItemRelations, type Database } from "@weft/db";
import {
  createAgentActions, createCommentActions, createCycleActions, createIntakeActions, createOutboundWebhookActions, createWorkItemTypeActions, createJobHandlers, createNotificationActions, createProjectActions, createRelationActions, createTriggerActions,
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

test.concurrent("Intake submission and edits persist assignees, labels, and due date with Activity", async () => {
  await withRollback(db, async (transaction) => {
    const { admin, member, guest, intake, project } = await setup(transaction);
    const label = await createWorkItemActions(transaction).createLabel.handler({ userId: admin.id }, { projectId: project.id, name: "Customer" });
    const dueDate = "2030-05-06";
    const created = await intake.submitIntakeItem.handler({ userId: guest.id }, { projectId: project.id, title: "Properties on submit", assigneeIds: [member.id], labelIds: [label.id], dueDate });
    expect(created).toMatchObject({ assigneeIds: [member.id], labelIds: [label.id], dueDate });
    expect(await transaction.select().from(workItemAssignees).where(eq(workItemAssignees.workItemId, created.workItemId))).toMatchObject([{ userId: member.id }]);
    expect(await transaction.select().from(workItemLabels).where(eq(workItemLabels.workItemId, created.workItemId))).toMatchObject([{ labelId: label.id }]);
    expect((await transaction.select().from(workItems).where(eq(workItems.id, created.workItemId)))[0]?.dueDate).toBe(dueDate);

    const updated = await intake.updateIntakeItem.handler({ userId: guest.id }, { intakeItemId: created.id, assigneeIds: [admin.id], labelIds: [], dueDate: null });
    expect(updated).toMatchObject({ title: "Properties on submit", assigneeIds: [admin.id], labelIds: [], dueDate: null });
    expect(await transaction.select().from(workItemAssignees).where(eq(workItemAssignees.workItemId, created.workItemId))).toMatchObject([{ userId: admin.id }]);
    expect(await transaction.select().from(workItemLabels).where(eq(workItemLabels.workItemId, created.workItemId))).toHaveLength(0);
    expect((await transaction.select().from(workItems).where(eq(workItems.id, created.workItemId)))[0]?.dueDate).toBeNull();
    const fields = (await transaction.select({ field: activities.field }).from(activities).where(eq(activities.entityId, created.workItemId))).map((row) => row.field);
    expect(fields).toEqual(expect.arrayContaining(["assignees", "labels", "dueDate"]));
    await expect(intake.updateIntakeItem.handler({ userId: guest.id }, { intakeItemId: created.id, dueDate: "2030-02-31" })).rejects.toMatchObject({ status: 400 });
  });
});

test.concurrent("an Agent assigned to Intake waits for acceptance, then gets one Run", async () => {
  await withRollback(db, async (transaction) => {
    const { admin, member, workspace, project, intake } = await setup(transaction);
    const agents = createAgentActions(transaction);
    const agent = await agents.createAgent.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Intake Agent", instructions: "Review approved requests", model: "default" });
    await agents.setAgentProjectAccess.handler({ userId: admin.id }, { agentId: agent.id, allProjects: false, projectIds: [project.id] });
    await createTriggerActions(transaction).createTrigger.handler({ userId: admin.id }, { agentId: agent.id, projectId: project.id, eventType: "work_item_created" });
    const label = await createWorkItemActions(transaction).createLabel.handler({ userId: admin.id }, { projectId: project.id, name: "Approved context" });
    const created = await intake.submitIntakeItem.handler({ userId: member.id }, { projectId: project.id, title: "Not approved yet", assigneeIds: [agent.userId], labelIds: [label.id], dueDate: "2030-05-06" });
    expect(await transaction.select().from(runs).where(eq(runs.workItemId, created.workItemId))).toHaveLength(0);
    const accepted = await intake.acceptIntakeItem.handler({ userId: member.id }, { intakeItemId: created.id });
    expect(accepted).toMatchObject({ outcome: "accepted", assigneeIds: [agent.userId], labelIds: [label.id], dueDate: "2030-05-06" });
    expect(await transaction.select().from(runs).where(eq(runs.workItemId, created.workItemId))).toHaveLength(1);
  });
});

test.concurrent("Intake property validation rejects foreign labels, non-members, and Agents outside the actor's access", async () => {
  await withRollback(db, async (transaction) => {
    const { admin, member, guest, workspace, project, intake } = await setup(transaction);
    const foreignProject = await createProjectActions(transaction).createProject.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Other", key: "OTH", visibility: "public" });
    const foreignLabel = await createWorkItemActions(transaction).createLabel.handler({ userId: admin.id }, { projectId: foreignProject.id, name: "Private label" });
    const agents = createAgentActions(transaction);
    const agent = await agents.createAgent.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Restricted Agent", instructions: "Review requests", model: "default" });
    await agents.setAgentProjectAccess.handler({ userId: admin.id }, { agentId: agent.id, allProjects: false, projectIds: [project.id] });
    await agents.setAgentAccess.handler({ userId: admin.id }, { agentId: agent.id, userIds: [admin.id] });
    await expect(intake.submitIntakeItem.handler({ userId: guest.id }, { projectId: project.id, title: "Bad label", labelIds: [foreignLabel.id] })).rejects.toMatchObject({ status: 400 });
    await expect(intake.submitIntakeItem.handler({ userId: guest.id }, { projectId: project.id, title: "Not a member", assigneeIds: [workspace.id] })).rejects.toMatchObject({ status: 400 });
    await expect(intake.submitIntakeItem.handler({ userId: member.id }, { projectId: project.id, title: "No Agent access", assigneeIds: [agent.userId] })).rejects.toMatchObject({ status: 403 });
  });
});

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

test.concurrent("Intake submit and update save legacy alignment with the same warning code", async () => {
  await withRollback(db, async (transaction) => {
    const { member, project, intake } = await setup(transaction);
    const description = { type: "doc", content: [{ type: "paragraph", attrs: { textAlign: "center" }, content: [{ type: "text", text: "Aligned" }] }] };
    const created = await intake.submitIntakeItem.handler({ userId: member.id }, { projectId: project.id, title: "Legacy alignment", description });
    expect(created.descriptionMarkdown).toContain("Aligned");
    expect(created.descriptionMarkdownWarningDetails).toContainEqual(expect.objectContaining({ code: "attribute-not-persisted", message: expect.stringContaining("text alignment") }));
    const updated = await intake.updateIntakeItem.handler({ userId: member.id }, { intakeItemId: created.id, description });
    expect(updated.descriptionMarkdownWarningDetails).toContainEqual(expect.objectContaining({ code: "attribute-not-persisted" }));
  });
});

test.concurrent("Intake stores submitted descriptions in Written form", async () => {
  await withRollback(db, async (transaction) => {
    const { member, project, intake } = await setup(transaction);
    const submitted = await intake.submitIntakeItem.handler({ userId: member.id }, { projectId: project.id, title: "Markdown idea", descriptionMarkdown: "**keep this wording**" });
    const [stored] = await transaction.select({ markdown: workItems.descriptionMarkdown, legacy: workItems.description }).from(workItems).where(eq(workItems.id, submitted.workItemId));
    expect(stored).toEqual({ markdown: "**keep this wording**", legacy: null });
  });
});

test.concurrent("Intake content edits are limited to creators and Admins on pending or snoozed items", async () => {
  await withRollback(db, async (transaction) => {
    const { admin, member, guest, workspace, submit, intake, project } = await setup(transaction);
    const workspaceAdmin = await createMemberFactory(transaction, workspace.id, "Admin");
    const created = await submit(guest.id, "Original");
    const changed = await intake.updateIntakeItem.handler({ userId: guest.id }, { intakeItemId: created.id, title: "Corrected", descriptionMarkdown: "**More detail**", priority: "high" });
    expect(changed).toMatchObject({ title: "Corrected", descriptionMarkdown: "**More detail**", priority: "high" });
    await expect(intake.updateIntakeItem.handler({ userId: member.id }, { intakeItemId: created.id, title: "Other member" })).rejects.toMatchObject({ status: 403 });
    expect((await intake.updateIntakeItem.handler({ userId: admin.id }, { intakeItemId: created.id, title: "Admin edit" })).title).toBe("Admin edit");
    expect((await intake.updateIntakeItem.handler({ userId: workspaceAdmin.id }, { intakeItemId: created.id, title: "Workspace admin edit" })).title).toBe("Workspace admin edit");
    const snoozed = await intake.snoozeIntakeItem.handler({ userId: member.id }, { intakeItemId: created.id, snoozedTill: new Date(Date.now() + 3_600_000).toISOString() });
    expect((await intake.updateIntakeItem.handler({ userId: guest.id }, { intakeItemId: snoozed.id, title: "Snoozed edit" })).title).toBe("Snoozed edit");
    for (const action of [intake.rejectIntakeItem, intake.duplicateIntakeItem]) {
      // Reject and duplicate are checked below after each item is decided.
      const item = await submit(guest.id, "Frozen");
      if (action === intake.rejectIntakeItem) await action.handler({ userId: member.id }, { intakeItemId: item.id });
      else {
        const normal = await createWorkItemActions(transaction).createWorkItem.handler({ userId: admin.id }, { projectId: project.id, title: "Existing" });
        await action.handler({ userId: member.id }, { intakeItemId: item.id, duplicateTo: normal.id });
      }
      await expect(intake.updateIntakeItem.handler({ userId: guest.id }, { intakeItemId: item.id, title: "Should be frozen" })).rejects.toMatchObject({ status: 400 });
    }
    expect(await transaction.select().from(activities).where(and(eq(activities.entityType, "work_item"), eq(activities.projectId, project.id), eq(activities.field, "title")))).toHaveLength(4);
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

test.concurrent("accept refuses an Intake item missing a required property", async () => {
  await withRollback(db, async (transaction) => {
    const { admin, member, project, projects, intake, submit } = await setup(transaction);
    await projects.setProjectFeatures.handler({ userId: admin.id }, { projectId: project.id, features: { types: true, intake: true } });
    const types = createWorkItemTypeActions(transaction);
    const [task] = await types.listWorkItemTypes.handler({ userId: admin.id }, { projectId: project.id });
    await types.createCustomProperty.handler({ userId: admin.id }, { projectId: project.id, name: "Decision", kind: "text", required: true, typeIds: [task!.id] });
    const submitted = await submit(member.id);
    await expect(intake.acceptIntakeItem.handler({ userId: admin.id }, { intakeItemId: submitted.id }))
      .rejects.toMatchObject({ status: 400, message: '"Decision" is required for Task. Fill it before saving.' });
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

test.concurrent("a project writer can unsnooze an item early and return it to pending", async () => {
  await withRollback(db, async (transaction) => {
    const { admin, member, guest, submit, intake, project, projects, workspace } = await setup(transaction);
    const created = await submit(guest.id);
    const till = new Date(Date.now() + 3_600_000).toISOString();
    await intake.snoozeIntakeItem.handler({ userId: member.id }, { intakeItemId: created.id, snoozedTill: till });

    const restored = await intake.unsnoozeIntakeItem.handler({ userId: member.id }, { intakeItemId: created.id });
    expect(restored).toMatchObject({ id: created.id, outcome: "pending", snoozedTill: null });
    expect(await intake.listIntakeItems.handler({ userId: member.id }, { projectId: project.id, outcome: "pending" })).toHaveLength(1);
    expect(await intake.listIntakeItems.handler({ userId: member.id }, { projectId: project.id, outcome: "snoozed" })).toHaveLength(0);
    expect(await transaction.select().from(activities).where(and(eq(activities.entityId, created.workItemId), eq(activities.field, "intake_unsnoozed")))).toHaveLength(1);

    const adminItem = await submit(member.id, "Admin unsnoozes");
    await intake.snoozeIntakeItem.handler({ userId: member.id }, { intakeItemId: adminItem.id, snoozedTill: till });
    expect((await intake.unsnoozeIntakeItem.handler({ userId: admin.id }, { intakeItemId: adminItem.id })).outcome).toBe("pending");

    await expect(intake.unsnoozeIntakeItem.handler({ userId: member.id }, { intakeItemId: created.id })).rejects.toMatchObject({ status: 400 });
    await intake.snoozeIntakeItem.handler({ userId: member.id }, { intakeItemId: created.id, snoozedTill: till });
    await expect(intake.unsnoozeIntakeItem.handler({ userId: guest.id }, { intakeItemId: created.id })).rejects.toMatchObject({ status: 403 });
    await transaction.update(intakeItems).set({ snoozedTill: new Date(Date.now() - 1000) }).where(eq(intakeItems.id, created.id));
    await expect(intake.unsnoozeIntakeItem.handler({ userId: member.id }, { intakeItemId: created.id })).rejects.toMatchObject({ status: 400 });
    await transaction.update(intakeItems).set({ snoozedTill: new Date(Date.now() + 3_600_000) }).where(eq(intakeItems.id, created.id));
    await projects.archiveProject.handler({ userId: admin.id }, { projectId: project.id });
    await expect(intake.unsnoozeIntakeItem.handler({ userId: admin.id }, { intakeItemId: created.id })).rejects.toMatchObject({ status: 400, message: "Project is archived" });
    await projects.unarchiveProject.handler({ userId: admin.id }, { projectId: project.id });

    const otherProject = await projects.createProject.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Other", key: "OTH", visibility: "public" });
    const elsewhere = await intake.submitIntakeItem.handler({ userId: admin.id }, { projectId: otherProject.id, title: "Other project item" });
    await intake.snoozeIntakeItem.handler({ userId: admin.id }, { intakeItemId: elsewhere.id, snoozedTill: till });
    await expect(intake.unsnoozeIntakeItem.handler({ userId: member.id }, { intakeItemId: elsewhere.id })).rejects.toMatchObject({ status: 403 });

    await projects.setProjectFeatures.handler({ userId: admin.id }, { projectId: project.id, features: { intake: false } });
    await expect(intake.unsnoozeIntakeItem.handler({ userId: admin.id }, { intakeItemId: created.id })).rejects.toMatchObject({ status: 400 });
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
    const found = await createSearchActions(transaction).searchWorkItems.handler({ userId: admin.id }, { workspaceId: workspace.id, projectId: project.id, filter: 'title ~ "intake"' });
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
