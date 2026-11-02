import { afterAll, expect, test } from "bun:test";
import { createDatabase, type Database } from "@weft/db";
import { createEstimateActions, createProjectActions, createWorkItemActions } from "../src";
import { createMemberFactory, createWorkspaceFactory, withRollback } from "../../db/src/test-helpers";

const { client, db } = createDatabase();
afterAll(async () => client.end());

async function setup(transaction: Database, estimate?: { type: "points" | "categories"; values: string[] }) {
  const workspace = await createWorkspaceFactory(transaction);
  const admin = await createMemberFactory(transaction, workspace.id, "Admin");
  const projects = createProjectActions(transaction);
  const items = createWorkItemActions(transaction);
  const estimates = createEstimateActions(transaction);
  const project = await projects.createProject.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Mobile", key: "MOB", visibility: "private" });
  const created = estimate ? await estimates.createEstimate.handler({ userId: admin.id }, { projectId: project.id, ...estimate }) : null;
  const point = (value: string) => created!.points.find((entry) => entry.value === value)!.id;
  const create = (title: string, size?: string) => items.createWorkItem.handler({ userId: admin.id }, { projectId: project.id, title, ...(size ? { estimatePointId: point(size) } : {}) });
  const list = async (query: string) => (await items.listWorkItems.handler({ userId: admin.id }, { projectId: project.id, query })).map((item) => item.title);
  const error = (query: string) => list(query).then(() => null, (caught: { message: string; status: number }) => caught);
  return { admin, project, items, estimates, create, list, error };
}

test.concurrent("points compare numerically, not as text", async () => {
  await withRollback(db, async (transaction) => {
    const { create, list } = await setup(transaction, { type: "points", values: ["1", "2", "3", "5", "8", "13"] });
    await create("one", "1"); await create("five", "5"); await create("eight", "8"); await create("thirteen", "13"); await create("unsized");
    expect(await list("estimate = 8")).toEqual(["eight"]);
    expect(await list("estimate >= 8 ORDER BY estimate")).toEqual(["eight", "thirteen"]);
    expect(await list("estimate > 5 ORDER BY estimate DESC")).toEqual(["thirteen", "eight"]);
    expect(await list("estimate < 8 ORDER BY estimate")).toEqual(["one", "five"]);
    expect(await list("estimate <= 1")).toEqual(["one"]);
    expect(await list("estimate BETWEEN 2 AND 8 ORDER BY estimate")).toEqual(["five", "eight"]);
    expect(await list("estimate IN (1, 13) ORDER BY title")).toEqual(["one", "thirteen"]);
    expect(await list("estimate != 8 ORDER BY title")).toEqual(["five", "one", "thirteen", "unsized"]);
    expect(await list("estimate NOT IN (1, 13, 8) ORDER BY title")).toEqual(["five", "unsized"]);
    expect(await list("estimate IS NULL")).toEqual(["unsized"]);
    expect(await list("estimate IS NOT NULL ORDER BY title")).toEqual(["eight", "five", "one", "thirteen"]);
  });
});

test.concurrent("categories match by equality or membership, case-insensitively", async () => {
  await withRollback(db, async (transaction) => {
    const { create, list } = await setup(transaction, { type: "categories", values: ["S", "M", "L"] });
    await create("small", "S"); await create("medium", "M"); await create("large", "L"); await create("unsized");
    expect(await list("estimate = M")).toEqual(["medium"]);
    expect(await list("estimate = m")).toEqual(["medium"]);
    expect(await list('estimate IN (S, "L") ORDER BY estimate')).toEqual(["small", "large"]);
    expect(await list("estimate != S ORDER BY title")).toEqual(["large", "medium", "unsized"]);
    expect(await list("estimate IS NULL")).toEqual(["unsized"]);
  });
});

test.concurrent("an invalid value is a PQL error naming the allowed values", async () => {
  await withRollback(db, async (transaction) => {
    const points = await setup(transaction, { type: "points", values: ["1", "2", "3"] });
    expect((await points.error("estimate = 4"))?.message).toMatch(/"4".*use one of 1, 2, 3/);
    expect((await points.error("estimate >= big"))?.message).toMatch(/"big".*number/);
    expect((await points.error("estimate IN (1, 9)"))?.message).toContain("1, 2, 3");
    expect((await points.error("estimate = 4"))?.status).toBe(400);
    const categories = await setup(transaction, { type: "categories", values: ["S", "M", "L"] });
    expect((await categories.error("estimate = XL"))?.message).toMatch(/"XL".*use one of S, M, L/);
    expect((await categories.error("estimate > S"))?.message).toMatch(/categories.*=, !=, IN, NOT IN/);
  });
});

test.concurrent("a project without an active Estimate refuses the field", async () => {
  await withRollback(db, async (transaction) => {
    const none = await setup(transaction);
    expect((await none.error("estimate = 1"))?.message).toContain("no active Estimate");
    const off = await setup(transaction, { type: "points", values: ["1", "2"] });
    await off.estimates.updateEstimate.handler({ userId: off.admin.id }, { projectId: off.project.id, enabled: false });
    expect((await off.error("estimate = 1"))?.message).toContain("no active Estimate");
  });
});
