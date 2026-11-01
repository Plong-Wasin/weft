import { afterAll, expect, test } from "bun:test";
import { createDatabase, type Database } from "@weft/db";
import { createProjectActions } from "../src";
import { createMemberFactory, createUserFactory, createWorkspaceFactory, withRollback } from "../../db/src/test-helpers";

const { client, db } = createDatabase();
afterAll(async () => client.end());

async function setup(transaction: Database) {
  const workspace = await createWorkspaceFactory(transaction);
  const admin = await createMemberFactory(transaction, workspace.id, "Admin");
  const member = await createMemberFactory(transaction, workspace.id, "Member");
  const actions = createProjectActions(transaction);
  const create = (userId: string, key: string, visibility: "public" | "private" = "public") =>
    actions.createProject.handler({ userId }, { workspaceId: workspace.id, name: `Project ${key}`, key, visibility });
  return { workspace, admin, member, actions, create };
}

test.concurrent("a member creates a project and becomes its project Admin", async () => {
  await withRollback(db, async (transaction) => {
    const { workspace, member, actions, create } = await setup(transaction);
    const project = await create(member.id, "MOB");
    expect(project).toMatchObject({ key: "MOB", visibility: "public", archived: false, role: "Admin" });
    const members = await actions.listProjectMembers.handler({ userId: member.id }, { projectId: project.id });
    expect(members.map((row) => [row.userId, row.role])).toEqual([[member.id, "Admin"]]);
    const guest = await createMemberFactory(transaction, workspace.id, "Guest");
    await expect(create(guest.id, "NOPE")).rejects.toMatchObject({ status: 403 });
  });
});

test.concurrent("key validation: length, charset, leading letter, uniqueness across keys and aliases", async () => {
  await withRollback(db, async (transaction) => {
    const { admin, actions, create } = await setup(transaction);
    for (const bad of ["A", "ABCDEFGHIJKLM", "1AB", "ab", "A-B", "A B", "AB_C"]) {
      await expect(create(admin.id, bad)).rejects.toMatchObject({ status: 400 });
    }
    for (const good of ["AB", "ABCDEFGHIJKL", "A1"]) await create(admin.id, good);
    await expect(create(admin.id, "AB")).rejects.toMatchObject({ status: 400 });
    const project = await create(admin.id, "OLD");
    await actions.renameProjectKey.handler({ userId: admin.id }, { projectId: project.id, key: "NEW" });
    await expect(create(admin.id, "OLD")).rejects.toMatchObject({ status: 400 });
    const other = await create(admin.id, "OTH");
    await expect(actions.renameProjectKey.handler({ userId: admin.id }, { projectId: other.id, key: "OLD" })).rejects.toMatchObject({ status: 400 });
  });
});

test.concurrent("the same key can exist in two workspaces", async () => {
  await withRollback(db, async (transaction) => {
    const first = await setup(transaction);
    const second = await setup(transaction);
    await first.create(first.admin.id, "SAME");
    await second.create(second.admin.id, "SAME");
  });
});

test.concurrent("private projects are invisible to non-members; workspace Admins see everything", async () => {
  await withRollback(db, async (transaction) => {
    const { workspace, admin, member, actions, create } = await setup(transaction);
    const outsider = await createMemberFactory(transaction, workspace.id, "Member");
    const secret = await create(member.id, "SEC", "private");
    await create(member.id, "PUB", "public");
    const keysFor = async (userId: string) => (await actions.listProjects.handler({ userId }, { workspaceId: workspace.id })).map((row) => row.key);
    expect(await keysFor(outsider.id)).toEqual(["PUB"]);
    expect(await keysFor(member.id)).toEqual(["PUB", "SEC"]);
    expect(await keysFor(admin.id)).toEqual(["PUB", "SEC"]);
    await expect(actions.getProject.handler({ userId: outsider.id }, { workspaceId: workspace.id, key: "SEC" })).rejects.toMatchObject({ status: 404 });
    await expect(actions.listProjectMembers.handler({ userId: outsider.id }, { projectId: secret.id })).rejects.toMatchObject({ status: 404 });
    await expect(actions.joinProject.handler({ userId: outsider.id }, { projectId: secret.id })).rejects.toMatchObject({ status: 404 });
    expect((await actions.getProject.handler({ userId: admin.id }, { workspaceId: workspace.id, key: "SEC" })).id).toBe(secret.id);
    const stranger = await createUserFactory(transaction);
    await expect(actions.listProjects.handler({ userId: stranger.id }, { workspaceId: workspace.id })).rejects.toMatchObject({ status: 403 });
  });
});

test.concurrent("workspace members join public projects; a public project can be made private", async () => {
  await withRollback(db, async (transaction) => {
    const { workspace, member, actions, create } = await setup(transaction);
    const joiner = await createMemberFactory(transaction, workspace.id, "Member");
    const guest = await createMemberFactory(transaction, workspace.id, "Guest");
    const project = await create(member.id, "OPEN");
    expect(await actions.joinProject.handler({ userId: joiner.id }, { projectId: project.id })).toMatchObject({ role: "Member" });
    expect(await actions.joinProject.handler({ userId: guest.id }, { projectId: project.id })).toMatchObject({ role: "Guest" });
    expect(await actions.joinProject.handler({ userId: joiner.id }, { projectId: project.id })).toMatchObject({ role: "Member" });
    expect(await actions.listProjectMembers.handler({ userId: joiner.id }, { projectId: project.id })).toHaveLength(3);
    await expect(actions.updateProject.handler({ userId: joiner.id }, { projectId: project.id, visibility: "private" })).rejects.toMatchObject({ status: 403 });
    const updated = await actions.updateProject.handler({ userId: member.id }, { projectId: project.id, name: "Renamed", visibility: "private" });
    expect(updated).toMatchObject({ name: "Renamed", visibility: "private" });
  });
});

test.concurrent("project Admin manages members; last Admin is protected; only workspace members can be added", async () => {
  await withRollback(db, async (transaction) => {
    const { workspace, member, actions, create } = await setup(transaction);
    const colleague = await createMemberFactory(transaction, workspace.id, "Member");
    const stranger = await createUserFactory(transaction);
    const project = await create(member.id, "TEAM", "private");
    const owner = { userId: member.id };
    await expect(actions.addProjectMember.handler(owner, { projectId: project.id, userId: stranger.id, role: "Member" })).rejects.toMatchObject({ status: 400 });
    await actions.addProjectMember.handler(owner, { projectId: project.id, userId: colleague.id, role: "Member" });
    await expect(actions.addProjectMember.handler({ userId: colleague.id }, { projectId: project.id, userId: colleague.id, role: "Admin" })).rejects.toMatchObject({ status: 403 });
    expect(await actions.changeProjectMemberRole.handler(owner, { projectId: project.id, userId: colleague.id, role: "Admin" })).toMatchObject({ role: "Admin" });
    await actions.changeProjectMemberRole.handler(owner, { projectId: project.id, userId: member.id, role: "Member" });
    await expect(actions.changeProjectMemberRole.handler({ userId: colleague.id }, { projectId: project.id, userId: colleague.id, role: "Guest" })).rejects.toMatchObject({ status: 400 });
    await expect(actions.removeProjectMember.handler({ userId: colleague.id }, { projectId: project.id, userId: colleague.id })).rejects.toMatchObject({ status: 400 });
    await actions.removeProjectMember.handler({ userId: colleague.id }, { projectId: project.id, userId: member.id });
    await expect(actions.listProjectMembers.handler(owner, { projectId: project.id })).rejects.toMatchObject({ status: 404 });
  });
});

test.concurrent("renaming a key stores an alias and the old key still resolves", async () => {
  await withRollback(db, async (transaction) => {
    const { workspace, member, actions, create } = await setup(transaction);
    const project = await create(member.id, "OLD");
    const viewer = await createMemberFactory(transaction, workspace.id, "Member");
    await expect(actions.renameProjectKey.handler({ userId: viewer.id }, { projectId: project.id, key: "NEW" })).rejects.toMatchObject({ status: 403 });
    expect(await actions.renameProjectKey.handler({ userId: member.id }, { projectId: project.id, key: "NEW" })).toMatchObject({ key: "NEW" });
    const byOld = await actions.getProject.handler({ userId: viewer.id }, { workspaceId: workspace.id, key: "OLD" });
    expect(byOld).toMatchObject({ id: project.id, key: "NEW", viaAlias: true });
    expect(await actions.getProject.handler({ userId: viewer.id }, { workspaceId: workspace.id, key: "NEW" })).toMatchObject({ viaAlias: false });
    await actions.renameProjectKey.handler({ userId: member.id }, { projectId: project.id, key: "OLD" });
    expect(await actions.getProject.handler({ userId: viewer.id }, { workspaceId: workspace.id, key: "NEW" })).toMatchObject({ id: project.id, key: "OLD", viaAlias: true });
    await expect(actions.getProject.handler({ userId: viewer.id }, { workspaceId: workspace.id, key: "NONE" })).rejects.toMatchObject({ status: 404 });
  });
});

test.concurrent("archive hides a project from the default list; unarchive restores it", async () => {
  await withRollback(db, async (transaction) => {
    const { workspace, member, actions, create } = await setup(transaction);
    const project = await create(member.id, "ARC");
    const viewer = await createMemberFactory(transaction, workspace.id, "Member");
    await expect(actions.archiveProject.handler({ userId: viewer.id }, { projectId: project.id })).rejects.toMatchObject({ status: 403 });
    expect(await actions.archiveProject.handler({ userId: member.id }, { projectId: project.id })).toMatchObject({ archived: true });
    const list = (archived?: boolean) => actions.listProjects.handler({ userId: member.id }, { workspaceId: workspace.id, archived });
    expect(await list()).toHaveLength(0);
    expect((await list(true)).map((row) => row.key)).toEqual(["ARC"]);
    await expect(actions.updateProject.handler({ userId: member.id }, { projectId: project.id, name: "X" })).rejects.toMatchObject({ status: 400 });
    await expect(actions.joinProject.handler({ userId: viewer.id }, { projectId: project.id })).rejects.toMatchObject({ status: 400 });
    expect(await actions.unarchiveProject.handler({ userId: member.id }, { projectId: project.id })).toMatchObject({ archived: false });
    expect((await list()).map((row) => row.key)).toEqual(["ARC"]);
  });
});

test.concurrent("workspace Admin governs a private project they are not a member of", async () => {
  await withRollback(db, async (transaction) => {
    const { admin, member, actions, create } = await setup(transaction);
    const project = await create(member.id, "GOV", "private");
    expect(await actions.archiveProject.handler({ userId: admin.id }, { projectId: project.id })).toMatchObject({ archived: true, role: null });
    await actions.unarchiveProject.handler({ userId: admin.id }, { projectId: project.id });
    expect(await actions.renameProjectKey.handler({ userId: admin.id }, { projectId: project.id, key: "GOV2" })).toMatchObject({ key: "GOV2" });
  });
});
