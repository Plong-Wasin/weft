import { afterAll, expect, test } from "bun:test";
import { createDatabase, type Database } from "@weft/db";
import { createEstimateActions, createProjectActions, createWorkItemActions } from "../src";
import { createMemberFactory, createWorkspaceFactory, withRollback } from "../../db/src/test-helpers";

const { client, db } = createDatabase();
afterAll(async () => client.end());

async function setup(transaction: Database) {
  const workspace = await createWorkspaceFactory(transaction);
  const admin = await createMemberFactory(transaction, workspace.id, "Admin");
  const projectAdmin = await createMemberFactory(transaction, workspace.id, "Member");
  const member = await createMemberFactory(transaction, workspace.id, "Member");
  const guest = await createMemberFactory(transaction, workspace.id, "Guest");
  const outsider = await createMemberFactory(transaction, workspace.id, "Member");
  const projects = createProjectActions(transaction);
  const project = await projects.createProject.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Mobile", key: "MOB", visibility: "private" });
  await projects.addProjectMember.handler({ userId: admin.id }, { projectId: project.id, userId: projectAdmin.id, role: "Admin" });
  await projects.addProjectMember.handler({ userId: admin.id }, { projectId: project.id, userId: member.id, role: "Member" });
  await projects.addProjectMember.handler({ userId: admin.id }, { projectId: project.id, userId: guest.id, role: "Guest" });
  return { workspace, admin, projectAdmin, member, guest, outsider, project, estimates: createEstimateActions(transaction) };
}
const status = (promise: Promise<unknown>) => promise.then(() => 200, (error: { status: number }) => error.status);

test.concurrent("a project Admin creates a points Estimate; values are stored as plain ordered points", async () => {
  await withRollback(db, async (transaction) => {
    const { estimates, projectAdmin, member, project } = await setup(transaction);
    expect(await estimates.getEstimate.handler({ userId: member.id }, { projectId: project.id })).toBeNull();
    const created = await estimates.createEstimate.handler({ userId: projectAdmin.id }, { projectId: project.id, type: "points", values: ["1", "2", "3", "5", "8", "13"] });
    expect(created).toMatchObject({ projectId: project.id, name: "Estimate", type: "points", enabled: true });
    expect(created.points.map((point) => [point.position, point.value])).toEqual([[0, "1"], [1, "2"], [2, "3"], [3, "5"], [4, "8"], [5, "13"]]);
    expect(await estimates.getEstimate.handler({ userId: member.id }, { projectId: project.id })).toMatchObject({ id: created.id });
  });
});

test.concurrent("a categories Estimate keeps its own labels", async () => {
  await withRollback(db, async (transaction) => {
    const { estimates, admin, project } = await setup(transaction);
    const created = await estimates.createEstimate.handler({ userId: admin.id }, { projectId: project.id, name: "T-shirt", type: "categories", values: ["S", "M", "L"] });
    expect(created).toMatchObject({ name: "T-shirt", type: "categories" });
    expect(created.points.map((point) => point.value)).toEqual(["S", "M", "L"]);
  });
});

test.concurrent("a project has at most one Estimate", async () => {
  await withRollback(db, async (transaction) => {
    const { estimates, admin, project } = await setup(transaction);
    await estimates.createEstimate.handler({ userId: admin.id }, { projectId: project.id, type: "points", values: ["1", "2"] });
    const second = estimates.createEstimate.handler({ userId: admin.id }, { projectId: project.id, type: "categories", values: ["S", "M"] });
    expect(await status(second)).toBe(409);
    await expect(estimates.createEstimate.handler({ userId: admin.id }, { projectId: project.id, type: "categories", values: ["S", "M"] })).rejects.toThrow("already has an Estimate");
  });
});

test.concurrent("only a project Admin configures; Members, Guests and non-members are refused", async () => {
  await withRollback(db, async (transaction) => {
    const { estimates, admin, member, guest, outsider, project } = await setup(transaction);
    const create = (userId: string) => estimates.createEstimate.handler({ userId }, { projectId: project.id, type: "points", values: ["1", "2"] });
    expect(await status(create(member.id))).toBe(403);
    expect(await status(create(guest.id))).toBe(403);
    expect(await status(create(outsider.id))).toBe(404);
    const created = await create(admin.id);
    const update = (userId: string) => estimates.updateEstimate.handler({ userId }, { projectId: project.id, name: "Other" });
    expect(await status(update(member.id))).toBe(403);
    expect(await status(update(guest.id))).toBe(403);
    expect(await status(update(outsider.id))).toBe(404);
    expect(await status(estimates.deleteEstimatePoint.handler({ userId: member.id }, { pointId: created.points[0]!.id }))).toBe(403);
    expect(await status(estimates.deleteEstimatePoint.handler({ userId: outsider.id }, { pointId: created.points[0]!.id }))).toBe(404);
    expect(await status(estimates.getEstimate.handler({ userId: outsider.id }, { projectId: project.id }))).toBe(404);
  });
});

test.concurrent("the value count must be 2 to 6, values must fit the type and differ", async () => {
  await withRollback(db, async (transaction) => {
    const { estimates, admin, project } = await setup(transaction);
    const create = (type: "points" | "categories", values: string[]) => status(estimates.createEstimate.handler({ userId: admin.id }, { projectId: project.id, type, values } as never));
    expect(await create("points", ["1"])).toBe(400);
    expect(await create("points", ["1", "2", "3", "4", "5", "6", "7"])).toBe(400);
    expect(await create("points", ["1", "x"])).toBe(400);
    expect(await create("points", ["1", "1.0"])).toBe(400);
    expect(await create("categories", ["S", "s"])).toBe(400);
    expect(await create("categories", ["S", " "])).toBe(400);
    expect(await create("points", ["0.5", "1", "2"])).toBe(200);
  });
});

test.concurrent("editing renames and reorders points, keeps their ids, and enforces the range", async () => {
  await withRollback(db, async (transaction) => {
    const { estimates, admin, project } = await setup(transaction);
    const created = await estimates.createEstimate.handler({ userId: admin.id }, { projectId: project.id, type: "categories", values: ["S", "M", "L"] });
    const [s, m, l] = created.points;
    const updated = await estimates.updateEstimate.handler({ userId: admin.id }, { projectId: project.id, name: "Sizes", points: [{ id: l!.id, value: "Large" }, { id: s!.id, value: "S" }, { value: "XL" }] });
    expect(updated.name).toBe("Sizes");
    expect(updated.points.map((point) => [point.id, point.value])).toEqual([[l!.id, "Large"], [s!.id, "S"], [updated.points[2]!.id, "XL"]]);
    expect(updated.points.some((point) => point.id === m!.id)).toBe(false);
    const edit = (points: Array<{ id?: string; value: string }>) => status(estimates.updateEstimate.handler({ userId: admin.id }, { projectId: project.id, points }));
    expect(await edit([{ id: l!.id, value: "Large" }])).toBe(400);
    expect(await edit([{ id: l!.id, value: "A" }, { id: l!.id, value: "B" }])).toBe(400);
    expect(await edit([{ id: crypto.randomUUID(), value: "A" }, { value: "B" }])).toBe(400);
    expect(await edit([{ value: "1" }, { value: "2" }, { value: "3" }, { value: "4" }, { value: "5" }, { value: "6" }, { value: "7" }])).toBe(400);
  });
});

test.concurrent("deleting a single point works while above 2 values and never below", async () => {
  await withRollback(db, async (transaction) => {
    const { estimates, admin, project } = await setup(transaction);
    const created = await estimates.createEstimate.handler({ userId: admin.id }, { projectId: project.id, type: "points", values: ["1", "2", "3"] });
    const after = await estimates.deleteEstimatePoint.handler({ userId: admin.id }, { pointId: created.points[1]!.id });
    expect(after.points.map((point) => [point.position, point.value])).toEqual([[0, "1"], [1, "3"]]);
    expect(await status(estimates.deleteEstimatePoint.handler({ userId: admin.id }, { pointId: after.points[0]!.id }))).toBe(400);
    expect(await status(estimates.deleteEstimatePoint.handler({ userId: admin.id }, { pointId: crypto.randomUUID() }))).toBe(404);
  });
});

test.concurrent("a turned-off Estimate is hidden from Members, refuses writes, keeps its scale, and comes back when turned on", async () => {
  await withRollback(db, async (transaction) => {
    const { estimates, admin, member, project } = await setup(transaction);
    const created = await estimates.createEstimate.handler({ userId: admin.id }, { projectId: project.id, type: "points", values: ["1", "2", "3"] });
    const off = await estimates.updateEstimate.handler({ userId: admin.id }, { projectId: project.id, enabled: false });
    expect(off.enabled).toBe(false);
    expect(await estimates.getEstimate.handler({ userId: member.id }, { projectId: project.id })).toBeNull();
    expect(await estimates.getEstimate.handler({ userId: admin.id }, { projectId: project.id })).toMatchObject({ enabled: false, points: created.points });
    expect(await status(estimates.updateEstimate.handler({ userId: admin.id }, { projectId: project.id, name: "X" }))).toBe(400);
    expect(await status(estimates.updateEstimate.handler({ userId: admin.id }, { projectId: project.id, points: [{ value: "1" }, { value: "2" }] }))).toBe(400);
    expect(await status(estimates.deleteEstimatePoint.handler({ userId: admin.id }, { pointId: created.points[0]!.id }))).toBe(400);
    const on = await estimates.updateEstimate.handler({ userId: admin.id }, { projectId: project.id, enabled: true });
    expect(on).toMatchObject({ enabled: true, points: created.points });
    expect(await estimates.getEstimate.handler({ userId: member.id }, { projectId: project.id })).toMatchObject({ id: created.id });
  });
});

test.concurrent("updating a project without an Estimate is a 404", async () => {
  await withRollback(db, async (transaction) => {
    const { estimates, admin, project } = await setup(transaction);
    expect(await status(estimates.updateEstimate.handler({ userId: admin.id }, { projectId: project.id, enabled: true }))).toBe(404);
  });
});

test.concurrent("a Member sets, changes and clears the Estimate point of a work item; Activity records each change", async () => {
  await withRollback(db, async (transaction) => {
    const { estimates, admin, member, project } = await setup(transaction);
    const items = createWorkItemActions(transaction);
    const estimate = await estimates.createEstimate.handler({ userId: admin.id }, { projectId: project.id, type: "points", values: ["1", "2", "3"] });
    const [one, two] = estimate.points;
    const item = await items.createWorkItem.handler({ userId: member.id }, { projectId: project.id, title: "Sized" });
    expect(item.estimatePointId).toBeNull();
    expect((await items.updateWorkItem.handler({ userId: member.id }, { workItemId: item.id, estimatePointId: one!.id })).estimatePointId).toBe(one!.id);
    expect((await items.updateWorkItem.handler({ userId: member.id, source: "mcp" }, { workItemId: item.id, estimatePointId: two!.id })).estimatePointId).toBe(two!.id);
    expect((await items.updateWorkItem.handler({ userId: member.id }, { workItemId: item.id, estimatePointId: null })).estimatePointId).toBeNull();
    const rows = (await items.listWorkItemActivities.handler({ userId: member.id }, { workItemId: item.id })).filter((row) => row.field === "estimate");
    expect(rows.map((row) => [row.oldValue === null ? null : String(row.oldValue), row.newValue === null ? null : String(row.newValue), row.actorId, row.source])).toEqual([[null, "1", member.id, "ui"], ["1", "2", member.id, "mcp"], ["2", null, member.id, "ui"]]);
    const created = await items.createWorkItem.handler({ userId: member.id }, { projectId: project.id, title: "Born sized", estimatePointId: two!.id });
    expect(created.estimatePointId).toBe(two!.id);
    expect((await items.listWorkItems.handler({ userId: member.id }, { projectId: project.id })).find((row) => row.id === created.id)?.estimatePointId).toBe(two!.id);
  });
});

test.concurrent("a point of another project, or of a disabled or missing Estimate, is refused", async () => {
  await withRollback(db, async (transaction) => {
    const { workspace, estimates, admin, member, project } = await setup(transaction);
    const items = createWorkItemActions(transaction);
    const other = await createProjectActions(transaction).createProject.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Web", key: "WEB", visibility: "private" });
    const otherEstimate = await estimates.createEstimate.handler({ userId: admin.id }, { projectId: other.id, type: "points", values: ["1", "2"] });
    const item = await items.createWorkItem.handler({ userId: member.id }, { projectId: project.id, title: "Sized" });
    const set = (id: string | null) => items.updateWorkItem.handler({ userId: member.id }, { workItemId: item.id, estimatePointId: id });
    expect(await status(set(otherEstimate.points[0]!.id))).toBe(400);
    expect(await status(set("00000000-0000-4000-8000-000000000000"))).toBe(400);
    const own = await estimates.createEstimate.handler({ userId: admin.id }, { projectId: project.id, type: "points", values: ["1", "2"] });
    await set(own.points[0]!.id);
    await estimates.updateEstimate.handler({ userId: admin.id }, { projectId: project.id, enabled: false });
    expect(await status(set(own.points[1]!.id))).toBe(400);
    expect(await status(items.createWorkItem.handler({ userId: member.id }, { projectId: project.id, title: "x", estimatePointId: own.points[0]!.id }))).toBe(400);
    expect((await items.getWorkItem.handler({ userId: admin.id }, { workspaceId: workspace.id, displayId: item.displayId })).estimatePointId).toBe(own.points[0]!.id);
  });
});

test.concurrent("a project without an Estimate refuses a point", async () => {
  await withRollback(db, async (transaction) => {
    const { member, project } = await setup(transaction);
    const items = createWorkItemActions(transaction);
    const item = await items.createWorkItem.handler({ userId: member.id }, { projectId: project.id, title: "Plain" });
    expect(await status(items.updateWorkItem.handler({ userId: member.id }, { workItemId: item.id, estimatePointId: "00000000-0000-4000-8000-000000000000" }))).toBe(400);
  });
});

test.concurrent("a viewer reads the point but cannot write it; a non-member reads nothing", async () => {
  await withRollback(db, async (transaction) => {
    const { workspace, estimates, admin, member, guest, outsider, project } = await setup(transaction);
    const items = createWorkItemActions(transaction);
    const estimate = await estimates.createEstimate.handler({ userId: admin.id }, { projectId: project.id, type: "categories", values: ["S", "M"] });
    const item = await items.createWorkItem.handler({ userId: member.id }, { projectId: project.id, title: "Sized", estimatePointId: estimate.points[0]!.id });
    expect((await items.getWorkItem.handler({ userId: guest.id }, { workspaceId: workspace.id, displayId: item.displayId })).estimatePointId).toBe(estimate.points[0]!.id);
    expect(await status(items.updateWorkItem.handler({ userId: guest.id }, { workItemId: item.id, estimatePointId: estimate.points[1]!.id }))).toBe(403);
    expect(await status(items.getWorkItem.handler({ userId: outsider.id }, { workspaceId: workspace.id, displayId: item.displayId }))).toBeGreaterThanOrEqual(403);
  });
});

test.concurrent("deleting a point that work items use is refused with the count", async () => {
  await withRollback(db, async (transaction) => {
    const { estimates, admin, member, project } = await setup(transaction);
    const items = createWorkItemActions(transaction);
    const estimate = await estimates.createEstimate.handler({ userId: admin.id }, { projectId: project.id, type: "points", values: ["1", "2", "3"] });
    const [first, second] = estimate.points;
    for (const title of ["a", "b"]) await items.createWorkItem.handler({ userId: member.id }, { projectId: project.id, title, estimatePointId: first!.id });
    await expect(estimates.deleteEstimatePoint.handler({ userId: admin.id }, { pointId: first!.id })).rejects.toThrow("used by 2 work items");
    await expect(estimates.updateEstimate.handler({ userId: admin.id }, { projectId: project.id, points: [{ id: second!.id, value: "2" }, { id: estimate.points[2]!.id, value: "3" }] })).rejects.toThrow("used by 2 work items");
    const removed = await estimates.deleteEstimatePoint.handler({ userId: admin.id }, { pointId: second!.id });
    expect(removed.points).toHaveLength(2);
  });
});
