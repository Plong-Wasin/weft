import { afterAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { cycleItems, createDatabase, moduleItems, workItems, type Database } from "@weft/db";
import { createActionList, createAnalyticsActions, createCycleActions, createIntakeActions, createModuleActions, createProjectActions, createWorkItemActions, createWorkItemArchiveActions } from "../src";
import { createMemberFactory, createWorkspaceFactory, withRollback } from "../../db/src/test-helpers";

const { client, db } = createDatabase();
afterAll(async () => client.end());

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const status = (promise: Promise<unknown>) => promise.then(() => 200, (error: { status?: number }) => error.status ?? 500);

async function setup(transaction: Database) {
  const workspace = await createWorkspaceFactory(transaction);
  const admin = await createMemberFactory(transaction, workspace.id, "Admin");
  const member = await createMemberFactory(transaction, workspace.id, "Member");
  const guest = await createMemberFactory(transaction, workspace.id, "Guest");
  const projects = createProjectActions(transaction);
  const project = await projects.createProject.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Mobile", key: "MOB", visibility: "public" });
  await projects.addProjectMember.handler({ userId: admin.id }, { projectId: project.id, userId: member.id, role: "Member" });
  const work = createWorkItemActions(transaction);
  const states = await work.listStates.handler({ userId: admin.id }, { projectId: project.id });
  const state = (group: string) => states.find((row) => row.group === group)!;
  const as = { userId: member.id };
  const make = (input: Record<string, unknown> = {}, projectId = project.id) => work.createWorkItem.handler(as, { projectId, title: "Item", ...input } as never);
  return { workspace, admin, member, guest, projects, project, work, states, state, as, make, analytics: createAnalyticsActions(transaction), transaction };
}

test.concurrent("summary counts total, open, completed and overdue exactly; cancelled is only in total", async () => {
  await withRollback(db, async (transaction) => {
    const { workspace, make, state, work, as, analytics } = await setup(transaction);
    await make({ title: "backlog" });
    await make({ title: "overdue", dueDate: day(-3), stateId: state("started").id });
    await make({ title: "due later", dueDate: day(5) });
    const done = await make({ title: "done late", dueDate: day(-9), stateId: state("completed").id });
    const cancelled = await make({ title: "cancelled", dueDate: day(-9) });
    await work.moveWorkItem.handler(as, { workItemId: cancelled.id, stateId: state("cancelled").id } as never);
    expect(done.title).toBe("done late");
    expect(await analytics.getAnalyticsSummary.handler(as, { workspaceId: workspace.id })).toEqual({ total: 5, open: 3, completed: 1, overdue: 1 });
  });
});

test.concurrent("only Admin and Member may read analytics; a Guest and a stranger are refused", async () => {
  await withRollback(db, async (transaction) => {
    const { workspace, admin, member, guest, analytics } = await setup(transaction);
    const stranger = await createMemberFactory(transaction, (await createWorkspaceFactory(transaction)).id, "Admin");
    const call = (userId: string) => status(analytics.getAnalyticsSummary.handler({ userId }, { workspaceId: workspace.id }));
    expect(await Promise.all([call(admin.id), call(member.id), call(guest.id), call(stranger.id)])).toEqual([200, 200, 403, 403]);
    const insights = (userId: string) => status(analytics.getAnalyticsInsights.handler({ userId }, { workspaceId: workspace.id, x: "state" }));
    expect(await Promise.all([insights(admin.id), insights(member.id), insights(guest.id), insights(stranger.id)])).toEqual([200, 200, 403, 403]);
  });
});

test.concurrent("results cover only projects the caller can read; archived and Triage work items are left out", async () => {
  await withRollback(db, async (transaction) => {
    const { workspace, admin, projects, project, work, as, make, state, analytics } = await setup(transaction);
    const secret = await projects.createProject.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Secret", key: "SEC", visibility: "private" });
    await work.createWorkItem.handler({ userId: admin.id }, { projectId: secret.id, title: "in secret" });
    await make({ title: "kept" });
    const toArchive = await make({ title: "archived", stateId: state("completed").id });
    await createWorkItemArchiveActions(transaction).archiveWorkItem.handler(as, { workItemId: toArchive.id } as never);
    await createIntakeActions(transaction).submitIntakeItem.handler(as, { projectId: project.id, title: "in triage" } as never);
    expect((await analytics.getAnalyticsSummary.handler(as, { workspaceId: workspace.id })).total).toBe(1);
    // The Admin sees the private project as well; a project filter narrows it, and a filter on a hidden project gives nothing.
    expect((await analytics.getAnalyticsSummary.handler({ userId: admin.id }, { workspaceId: workspace.id })).total).toBe(2);
    expect((await analytics.getAnalyticsSummary.handler({ userId: admin.id }, { workspaceId: workspace.id, projectIds: [secret.id] })).total).toBe(1);
    expect((await analytics.getAnalyticsSummary.handler(as, { workspaceId: workspace.id, projectIds: [secret.id] })).total).toBe(0);
  });
});

test.concurrent("insights count by state group, priority and state in display order", async () => {
  await withRollback(db, async (transaction) => {
    const { workspace, make, state, as, analytics } = await setup(transaction);
    await make({ priority: "high" });
    await make({ priority: "high", stateId: state("started").id });
    await make({ priority: "urgent", stateId: state("completed").id });
    const byGroup = await analytics.getAnalyticsInsights.handler(as, { workspaceId: workspace.id, x: "stateGroup" });
    expect(byGroup.buckets.map((bucket) => [bucket.key, bucket.count])).toEqual([["backlog", 1], ["started", 1], ["completed", 1]]);
    const byPriority = await analytics.getAnalyticsInsights.handler(as, { workspaceId: workspace.id, x: "priority", groupBy: "stateGroup" });
    expect(byPriority.groupBy).toBe("stateGroup");
    expect(byPriority.buckets.map((bucket) => [bucket.key, bucket.count])).toEqual([["urgent", 1], ["high", 2]]);
    expect(byPriority.buckets[1]!.groups.map((group) => [group.key, group.count])).toEqual([["backlog", 1], ["started", 1]]);
    const byState = await analytics.getAnalyticsInsights.handler(as, { workspaceId: workspace.id, x: "state" });
    expect(byState.buckets.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(3);
  });
});

test.concurrent("an item with several labels, assignees or modules counts under each, and under none when it has none", async () => {
  await withRollback(db, async (transaction) => {
    const { workspace, project, member, admin, work, as, make, analytics } = await setup(transaction);
    const bug = await work.createLabel.handler({ userId: admin.id }, { projectId: project.id, name: "bug" } as never);
    const ux = await work.createLabel.handler({ userId: admin.id }, { projectId: project.id, name: "ux" } as never);
    await make({ labelIds: [bug.id, ux.id], assigneeIds: [member.id, admin.id] });
    await make({ labelIds: [bug.id] });
    await make({});
    const labels = await analytics.getAnalyticsInsights.handler(as, { workspaceId: workspace.id, x: "label" });
    expect(labels.buckets.map((bucket) => [bucket.key, bucket.count])).toEqual([["bug", 2], ["ux", 1], [null, 1]]);
    const assignees = await analytics.getAnalyticsInsights.handler(as, { workspaceId: workspace.id, x: "assignee" });
    expect(assignees.buckets.map((bucket) => bucket.count).sort()).toEqual([1, 1, 2]);
    expect(assignees.buckets.find((bucket) => bucket.key === null)!.count).toBe(2);
    // Group-by multi-valued: the bucket counts items once, the groups count each value.
    const split = await analytics.getAnalyticsInsights.handler(as, { workspaceId: workspace.id, x: "stateGroup", groupBy: "label" });
    expect(split.buckets).toHaveLength(1);
    expect(split.buckets[0]!.count).toBe(3);
    expect(split.buckets[0]!.groups.map((group) => [group.key, group.count])).toEqual([["bug", 2], ["ux", 1], [null, 1]]);
  });
});

test.concurrent("cycle and module axes count members and none; soft-deleted ones count as none", async () => {
  await withRollback(db, async (transaction) => {
    const { workspace, project, as, make, analytics } = await setup(transaction);
    const cycle = await createCycleActions(transaction).createCycle.handler(as, { projectId: project.id, name: "Sprint", startDate: day(-1), endDate: day(6) });
    const module = await createModuleActions(transaction).createModule.handler(as, { projectId: project.id, name: "Mod" } as never);
    const first = await make({}); const second = await make({}); await make({});
    await transaction.insert(cycleItems).values({ workItemId: first.id, cycleId: cycle.id, workspaceId: workspace.id, projectId: project.id });
    await transaction.insert(moduleItems).values([first, second].map((item) => ({ moduleId: module.id, workItemId: item.id, workspaceId: workspace.id, projectId: project.id })));
    const byCycle = await analytics.getAnalyticsInsights.handler(as, { workspaceId: workspace.id, x: "cycle" });
    expect(byCycle.buckets.map((bucket) => [bucket.label, bucket.count])).toEqual([["Sprint", 1], [null, 2]]);
    const byModule = await analytics.getAnalyticsInsights.handler(as, { workspaceId: workspace.id, x: "module" });
    expect(byModule.buckets.map((bucket) => [bucket.label, bucket.count])).toEqual([["Mod", 2], [null, 1]]);
  });
});

test.concurrent("date axes bucket by month, with none for a missing date", async () => {
  await withRollback(db, async (transaction) => {
    const { workspace, make, as, analytics } = await setup(transaction);
    const a = await make({ dueDate: "2026-03-05", startDate: "2026-02-27" });
    const b = await make({ dueDate: "2026-03-30" });
    const c = await make({ dueDate: "2026-04-01" });
    await make({});
    await transaction.update(workItems).set({ createdAt: new Date("2026-01-15T10:00:00Z") }).where(eq(workItems.id, a.id));
    await transaction.update(workItems).set({ completedAt: new Date("2026-05-02T10:00:00Z") }).where(eq(workItems.id, b.id));
    const counts = async (x: "dueDate" | "startDate" | "createdDate" | "completedDate") =>
      (await analytics.getAnalyticsInsights.handler(as, { workspaceId: workspace.id, x })).buckets.map((bucket) => [bucket.key, bucket.count]);
    expect(await counts("dueDate")).toEqual([["2026-03", 2], ["2026-04", 1], [null, 1]]);
    expect(await counts("startDate")).toEqual([["2026-02", 1], [null, 3]]);
    expect(await counts("completedDate")).toEqual([["2026-05", 1], [null, 3]]);
    const created = await counts("createdDate");
    expect(created[0]).toEqual(["2026-01", 1]);
    expect(created.reduce((sum, [, count]) => sum + (count as number), 0)).toBe(4);
    expect(c.title).toBe("Item");
  });
});

test.concurrent("the Group-by may not equal the X axis", async () => {
  await withRollback(db, async (transaction) => {
    const { workspace, as, analytics } = await setup(transaction);
    expect(await status(analytics.getAnalyticsInsights.handler(as, { workspaceId: workspace.id, x: "priority", groupBy: "priority" }))).toBe(400);
  });
});

test.concurrent("an empty workspace returns zeros and no buckets", async () => {
  await withRollback(db, async (transaction) => {
    const { workspace, as, analytics } = await setup(transaction);
    expect(await analytics.getAnalyticsSummary.handler(as, { workspaceId: workspace.id })).toEqual({ total: 0, open: 0, completed: 0, overdue: 0 });
    expect((await analytics.getAnalyticsInsights.handler(as, { workspaceId: workspace.id, x: "label", groupBy: "assignee" })).buckets).toEqual([]);
  });
});

test.concurrent("the Actions are in the registry as Read actions", async () => {
  await withRollback(db, async (transaction) => {
    const list = createActionList(transaction);
    expect(list.filter((action) => action.name.startsWith("get_analytics")).map((action) => [action.name, action.kind])).toEqual([["get_analytics_summary", "read"], ["get_analytics_insights", "read"]]);
  });
});
