import { afterAll, expect, test } from "bun:test";
import { createDatabase, type Database } from "@weft/db";
import { createProjectActions, createProjectPreferenceActions } from "../src";
import { createMemberFactory, createUserFactory, createWorkspaceFactory, withRollback } from "../../db/src/test-helpers";

const { client, db } = createDatabase();
afterAll(async () => client.end());

async function setup(transaction: Database) {
  const workspace = await createWorkspaceFactory(transaction);
  const admin = await createMemberFactory(transaction, workspace.id, "Admin");
  const member = await createMemberFactory(transaction, workspace.id, "Member");
  const projects = createProjectActions(transaction);
  const prefs = createProjectPreferenceActions(transaction);
  const create = (userId: string, name: string, key: string, visibility: "public" | "private" = "public") =>
    projects.createProject.handler({ userId }, { workspaceId: workspace.id, name, key, visibility });
  const list = (userId: string) => prefs.listProjectPreferences.handler({ userId }, { workspaceId: workspace.id });
  return { workspace, admin, member, projects, prefs, create, list };
}

test.concurrent("stars and the expanded menu are stored per person and survive a fresh read", async () => {
  await withRollback(db, async (transaction) => {
    const { admin, member, prefs, create, list } = await setup(transaction);
    const alpha = await create(admin.id, "Alpha", "ALP");
    const beta = await create(admin.id, "Beta", "BET");
    await prefs.setProjectPreference.handler({ userId: member.id }, { projectId: beta.id, starred: true });
    await prefs.setProjectPreference.handler({ userId: member.id }, { projectId: alpha.id, expanded: true });
    // A later read (a second browser session) sees the same state.
    expect(await list(member.id)).toEqual(expect.arrayContaining([
      { projectId: beta.id, starred: true, position: null, expanded: false },
      { projectId: alpha.id, starred: false, position: null, expanded: true },
    ]));
    // Another person's sidebar is untouched.
    expect(await list(admin.id)).toEqual([]);
    await prefs.setProjectPreference.handler({ userId: member.id }, { projectId: beta.id, starred: false });
    expect((await list(member.id)).find((row) => row.projectId === beta.id)).toMatchObject({ starred: false });
  });
});

test.concurrent("the order is saved as a whole, is per person, and a reset puts it back to never ordered while keeping stars", async () => {
  await withRollback(db, async (transaction) => {
    const { workspace, admin, member, prefs, create, list } = await setup(transaction);
    const alpha = await create(admin.id, "Alpha", "ALP");
    const beta = await create(admin.id, "Beta", "BET");
    const gamma = await create(admin.id, "Gamma", "GAM");
    await prefs.setProjectPreference.handler({ userId: member.id }, { projectId: gamma.id, starred: true });
    await prefs.setProjectOrder.handler({ userId: member.id }, { workspaceId: workspace.id, projectIds: [gamma.id, alpha.id, beta.id] });
    const positions = (rows: Array<{ projectId: string; position: number | null }>) => Object.fromEntries(rows.map((row) => [row.projectId, row.position]));
    expect(positions(await list(member.id))).toEqual({ [gamma.id]: 0, [alpha.id]: 1, [beta.id]: 2 });
    // Admin never ordered anything: their sidebar is not changed by the member's order.
    expect(await list(admin.id)).toEqual([]);
    // A reorder that leaves one project out sends it back to never ordered.
    await prefs.setProjectOrder.handler({ userId: member.id }, { workspaceId: workspace.id, projectIds: [beta.id, alpha.id] });
    expect(positions(await list(member.id))).toEqual({ [gamma.id]: null, [alpha.id]: 1, [beta.id]: 0 });
    await prefs.resetProjectOrder.handler({ userId: member.id }, { workspaceId: workspace.id });
    const afterReset = await list(member.id);
    expect(afterReset.every((row) => row.position === null)).toBe(true);
    expect(afterReset.find((row) => row.projectId === gamma.id)).toMatchObject({ starred: true });
  });
});

test.concurrent("a project created after the order was saved has no position, so it sorts after the ordered ones", async () => {
  await withRollback(db, async (transaction) => {
    const { workspace, admin, prefs, create, list } = await setup(transaction);
    const alpha = await create(admin.id, "Alpha", "ALP");
    await prefs.setProjectOrder.handler({ userId: admin.id }, { workspaceId: workspace.id, projectIds: [alpha.id] });
    const fresh = await create(admin.id, "Aardvark", "AAR");
    const rows = await list(admin.id);
    // The new project has no row yet: the client treats it as never ordered.
    expect(rows.find((row) => row.projectId === fresh.id)).toBeUndefined();
    expect(rows.find((row) => row.projectId === alpha.id)).toMatchObject({ position: 0 });
  });
});

test.concurrent("a private project the person is not in never appears, and cannot be starred or ordered", async () => {
  await withRollback(db, async (transaction) => {
    const { workspace, admin, member, prefs, create, list } = await setup(transaction);
    const secret = await create(admin.id, "Secret", "SEC", "private");
    const open = await create(admin.id, "Open", "OPE", "public");
    await expect(prefs.setProjectPreference.handler({ userId: member.id }, { projectId: secret.id, starred: true })).rejects.toMatchObject({ status: 404 });
    await expect(prefs.setProjectOrder.handler({ userId: member.id }, { workspaceId: workspace.id, projectIds: [secret.id, open.id] })).rejects.toMatchObject({ status: 404 });
    expect((await list(member.id)).map((row) => row.projectId)).not.toContain(secret.id);
    await prefs.setProjectPreference.handler({ userId: admin.id }, { projectId: secret.id, starred: true });
    expect((await list(admin.id)).map((row) => row.projectId)).toContain(secret.id);
  });
});

test.concurrent("an order with a repeated project, or from someone outside the workspace, is refused", async () => {
  await withRollback(db, async (transaction) => {
    const { workspace, admin, prefs, create } = await setup(transaction);
    const alpha = await create(admin.id, "Alpha", "ALP");
    await expect(prefs.setProjectOrder.handler({ userId: admin.id }, { workspaceId: workspace.id, projectIds: [alpha.id, alpha.id] })).rejects.toMatchObject({ status: 400 });
    const outsider = await createUserFactory(transaction);
    await expect(prefs.listProjectPreferences.handler({ userId: outsider.id }, { workspaceId: workspace.id })).rejects.toMatchObject({ status: 403 });
    await expect(prefs.resetProjectOrder.handler({ userId: outsider.id }, { workspaceId: workspace.id })).rejects.toMatchObject({ status: 403 });
  });
});
