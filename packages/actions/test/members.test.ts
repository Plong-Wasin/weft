import { afterAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createDatabase, schema, type Database } from "@weft/db";
import { ActionError, createMemberActions, createProjectActions, createWorkItemActions, requireWorkspaceRole } from "../src";
import { createMemberFactory, createUserFactory, createWorkspaceFactory, withRollback } from "../../db/src/test-helpers";

const { client, db } = createDatabase();
afterAll(async () => client.end());

async function setup(transaction: Database, now?: () => Date) {
  const workspace = await createWorkspaceFactory(transaction);
  const admin = await createMemberFactory(transaction, workspace.id, "Admin");
  return { workspace, admin, actions: createMemberActions(transaction, now) };
}
const forbidden = { status: 403 };

test.concurrent("admin creates an invite; a new user accepts and gets the chosen role", async () => {
  await withRollback(db, async (transaction) => {
    const { workspace, admin, actions } = await setup(transaction);
    const invite = await actions.createInvite.handler({ userId: admin.id }, { workspaceId: workspace.id, role: "Guest" });
    const stored = await transaction.select().from(schema.workspaceInvites);
    expect(stored.find((row) => row.workspaceId === workspace.id)?.tokenHash).not.toBe(invite.token);
    const invitee = await createUserFactory(transaction);
    const joined = await actions.acceptInvite.handler({ userId: invitee.id }, { token: invite.token });
    expect(joined).toEqual({ workspaceId: workspace.id, slug: workspace.slug, role: "Guest" });
    const members = await actions.listMembers.handler({ userId: invitee.id }, { workspaceId: workspace.id });
    expect(members.map((member) => [member.userId, member.role])).toContainEqual([invitee.id, "Guest"]);
  });
});

test.concurrent("an existing member of another workspace joins a second one through an invite", async () => {
  await withRollback(db, async (transaction) => {
    const { workspace, admin, actions } = await setup(transaction);
    const other = await createWorkspaceFactory(transaction);
    const user = await createMemberFactory(transaction, other.id, "Admin");
    const invite = await actions.createInvite.handler({ userId: admin.id }, { workspaceId: workspace.id, role: "Member" });
    await actions.acceptInvite.handler({ userId: user.id }, { token: invite.token });
    const roles = await transaction.select().from(schema.workspaceMembers).where(eq(schema.workspaceMembers.userId, user.id));
    expect(roles.map((row) => row.role).sort()).toEqual(["Admin", "Member"]);
  });
});

test.concurrent("accepting an invite never changes the role of an existing member", async () => {
  await withRollback(db, async (transaction) => {
    const { workspace, admin, actions } = await setup(transaction);
    const invite = await actions.createInvite.handler({ userId: admin.id }, { workspaceId: workspace.id, role: "Guest" });
    const result = await actions.acceptInvite.handler({ userId: admin.id }, { token: invite.token });
    expect(result.role).toBe("Admin");
  });
});

test.concurrent("an expired invite is rejected and an unknown token is not found", async () => {
  await withRollback(db, async (transaction) => {
    let clock = new Date("2026-01-01T00:00:00Z");
    const { workspace, admin, actions } = await setup(transaction, () => clock);
    const invite = await actions.createInvite.handler({ userId: admin.id }, { workspaceId: workspace.id, role: "Member" });
    const invitee = await createUserFactory(transaction);
    clock = new Date("2026-01-09T00:00:00Z");
    await expect(actions.acceptInvite.handler({ userId: invitee.id }, { token: invite.token })).rejects.toMatchObject({ status: 410 });
    await expect(actions.acceptInvite.handler({ userId: invitee.id }, { token: "nope" })).rejects.toMatchObject({ status: 404 });
    expect(await transaction.select().from(schema.workspaceMembers).where(eq(schema.workspaceMembers.userId, invitee.id))).toHaveLength(0);
  });
});

test.concurrent("only an Admin can create invites, change roles, or remove members", async () => {
  await withRollback(db, async (transaction) => {
    const { workspace, admin, actions } = await setup(transaction);
    const member = await createMemberFactory(transaction, workspace.id, "Member");
    const guest = await createMemberFactory(transaction, workspace.id, "Guest");
    const outsider = await createUserFactory(transaction);
    for (const actor of [member, guest, outsider]) {
      const context = { userId: actor.id };
      await expect(actions.createInvite.handler(context, { workspaceId: workspace.id, role: "Member" })).rejects.toMatchObject(forbidden);
      await expect(actions.changeMemberRole.handler(context, { workspaceId: workspace.id, userId: guest.id, role: "Admin" })).rejects.toMatchObject(forbidden);
      await expect(actions.removeMember.handler(context, { workspaceId: workspace.id, userId: guest.id })).rejects.toMatchObject(forbidden);
    }
    const changed = await actions.changeMemberRole.handler({ userId: admin.id }, { workspaceId: workspace.id, userId: guest.id, role: "Member" });
    expect(changed.role).toBe("Member");
    await actions.removeMember.handler({ userId: admin.id }, { workspaceId: workspace.id, userId: guest.id });
    const left = await actions.listMembers.handler({ userId: admin.id }, { workspaceId: workspace.id });
    expect(left.map((row) => row.userId)).not.toContain(guest.id);
  });
});

test.concurrent("the last Admin cannot be demoted or removed", async () => {
  await withRollback(db, async (transaction) => {
    const { workspace, admin, actions } = await setup(transaction);
    await expect(actions.changeMemberRole.handler({ userId: admin.id }, { workspaceId: workspace.id, userId: admin.id, role: "Member" })).rejects.toMatchObject({ status: 400 });
    await expect(actions.removeMember.handler({ userId: admin.id }, { workspaceId: workspace.id, userId: admin.id })).rejects.toMatchObject({ status: 400 });
    const second = await createMemberFactory(transaction, workspace.id, "Admin");
    await actions.changeMemberRole.handler({ userId: admin.id }, { workspaceId: workspace.id, userId: second.id, role: "Guest" });
  });
});

test.concurrent("permission layer: Guest is read-only, Member writes, non-members are denied, workspaces are isolated", async () => {
  await withRollback(db, async (transaction) => {
    const { workspace, actions } = await setup(transaction);
    const other = await createWorkspaceFactory(transaction);
    const member = await createMemberFactory(transaction, workspace.id, "Member");
    const guest = await createMemberFactory(transaction, workspace.id, "Guest");
    const outsider = await createUserFactory(transaction);
    expect(await requireWorkspaceRole(transaction, guest.id, workspace.id, "read")).toBe("Guest");
    await expect(requireWorkspaceRole(transaction, guest.id, workspace.id, "write")).rejects.toBeInstanceOf(ActionError);
    expect(await requireWorkspaceRole(transaction, member.id, workspace.id, "write")).toBe("Member");
    await expect(requireWorkspaceRole(transaction, member.id, workspace.id, "admin")).rejects.toMatchObject(forbidden);
    await expect(requireWorkspaceRole(transaction, outsider.id, workspace.id, "read")).rejects.toMatchObject(forbidden);
    await expect(requireWorkspaceRole(transaction, member.id, other.id, "read")).rejects.toMatchObject(forbidden);
    expect(await actions.listMembers.handler({ userId: guest.id }, { workspaceId: workspace.id })).toHaveLength(3);
    await expect(actions.listMembers.handler({ userId: outsider.id }, { workspaceId: workspace.id })).rejects.toMatchObject(forbidden);
  });
});

test.concurrent("removing a member also removes their project memberships, so they cannot be assigned", async () => {
  await withRollback(db, async (transaction) => {
    const { workspace, admin, actions } = await setup(transaction);
    const member = await createMemberFactory(transaction, workspace.id, "Member");
    const projects = createProjectActions(transaction);
    const project = await projects.createProject.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Mobile", key: "MOB", visibility: "public" });
    await projects.addProjectMember.handler({ userId: admin.id }, { projectId: project.id, userId: member.id, role: "Member" });
    const work = createWorkItemActions(transaction);
    const item = await work.createWorkItem.handler({ userId: admin.id }, { projectId: project.id, title: "Task", assigneeIds: [member.id] });
    expect(item.assigneeIds).toEqual([member.id]);
    await actions.removeMember.handler({ userId: admin.id }, { workspaceId: workspace.id, userId: member.id });
    expect(await transaction.select().from(schema.projectMembers).where(eq(schema.projectMembers.userId, member.id))).toEqual([]);
    await expect(work.updateWorkItem.handler({ userId: admin.id }, { workItemId: item.id, assigneeIds: [member.id] })).rejects.toMatchObject({ status: 400 });
  });
});

test.concurrent("an Admin lists open invites and revokes one; a revoked invite cannot be accepted", async () => {
  await withRollback(db, async (transaction) => {
    const { workspace, admin, actions } = await setup(transaction);
    const member = await createMemberFactory(transaction, workspace.id, "Member");
    const invite = await actions.createInvite.handler({ userId: admin.id }, { workspaceId: workspace.id, role: "Member" });
    const open = await actions.listOpenInvites.handler({ userId: admin.id }, { workspaceId: workspace.id });
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ role: "Member" });
    expect(JSON.stringify(open)).not.toContain(invite.token);
    await expect(actions.listOpenInvites.handler({ userId: member.id }, { workspaceId: workspace.id })).rejects.toMatchObject(forbidden);
    await expect(actions.revokeInvite.handler({ userId: member.id }, { workspaceId: workspace.id, inviteId: open[0]!.id })).rejects.toMatchObject(forbidden);
    expect(await actions.revokeInvite.handler({ userId: admin.id }, { workspaceId: workspace.id, inviteId: open[0]!.id })).toEqual({ revoked: true });
    expect(await actions.listOpenInvites.handler({ userId: admin.id }, { workspaceId: workspace.id })).toEqual([]);
    const invitee = await createUserFactory(transaction);
    await expect(actions.acceptInvite.handler({ userId: invitee.id }, { token: invite.token })).rejects.toMatchObject({ status: 404 });
    await expect(actions.revokeInvite.handler({ userId: admin.id }, { workspaceId: workspace.id, inviteId: open[0]!.id })).rejects.toMatchObject({ status: 404 });
  });
});

test.concurrent("an Admin invite is single-use; a Member invite can be reused", async () => {
  await withRollback(db, async (transaction) => {
    const { workspace, admin, actions } = await setup(transaction);
    const adminInvite = await actions.createInvite.handler({ userId: admin.id }, { workspaceId: workspace.id, role: "Admin" });
    const first = await createUserFactory(transaction);
    const second = await createUserFactory(transaction);
    expect((await actions.acceptInvite.handler({ userId: first.id }, { token: adminInvite.token })).role).toBe("Admin");
    await expect(actions.acceptInvite.handler({ userId: second.id }, { token: adminInvite.token })).rejects.toMatchObject({ status: 404 });
    const memberInvite = await actions.createInvite.handler({ userId: admin.id }, { workspaceId: workspace.id, role: "Member" });
    await actions.acceptInvite.handler({ userId: first.id }, { token: memberInvite.token });
    expect((await actions.acceptInvite.handler({ userId: second.id }, { token: memberInvite.token })).role).toBe("Member");
  });
});
