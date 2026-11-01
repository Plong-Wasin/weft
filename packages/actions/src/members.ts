import { Type } from "@sinclair/typebox";
import { and, asc, count, eq } from "drizzle-orm";
import type { Database } from "@weft/db";
import { users, workspaceInvites, workspaceMembers, workspaces } from "@weft/db";

export const workspaceRoles = ["Admin", "Member", "Guest"] as const;
export type WorkspaceRole = (typeof workspaceRoles)[number];
export const roleLevel: Record<WorkspaceRole, number> = { Admin: 20, Member: 15, Guest: 5 };

export class ActionError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 | 410 | 413) {
    super(message);
  }
}

const roleSchema = Type.Union(workspaceRoles.map((role) => Type.Literal(role)));
const inviteTtlMs = 7 * 24 * 60 * 60 * 1000;

/** Permission layer: Guest may only run read actions; Admin-only actions need level 20. */
export async function requireWorkspaceRole(db: Database, userId: string, workspaceId: string, requirement: "read" | "write" | "admin"): Promise<WorkspaceRole> {
  const [member] = await db.select({ role: workspaceMembers.role }).from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)));
  if (!member) throw new ActionError("Forbidden", 403);
  const role = member.role as WorkspaceRole;
  const needed = requirement === "admin" ? roleLevel.Admin : requirement === "write" ? roleLevel.Member : roleLevel.Guest;
  if (roleLevel[role] < needed) throw new ActionError("Forbidden", 403);
  return role;
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Buffer.from(digest).toString("hex");
}

export function createMemberActions(db: Database, now: () => Date = () => new Date()) {
  const workspaceInput = { workspaceId: Type.String({ format: "uuid" }) };
  const memberOutput = Type.Object({ userId: Type.String(), name: Type.String(), email: Type.String(), role: roleSchema });

  async function adminCount(database: Database, workspaceId: string) {
    const [{ value }] = await database.select({ value: count() }).from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.role, "Admin")));
    return value;
  }

  return {
    listMembers: {
      name: "list_members", kind: "read" as const,
      input: Type.Object(workspaceInput),
      output: Type.Array(memberOutput),
      handler: async (context: { userId: string }, input: { workspaceId: string }) => {
        await requireWorkspaceRole(db, context.userId, input.workspaceId, "read");
        const rows = await db.select({ userId: users.id, name: users.name, email: users.email, role: workspaceMembers.role })
          .from(workspaceMembers).innerJoin(users, eq(users.id, workspaceMembers.userId))
          .where(eq(workspaceMembers.workspaceId, input.workspaceId)).orderBy(asc(workspaceMembers.createdAt), asc(users.id));
        return rows as Array<{ userId: string; name: string; email: string; role: WorkspaceRole }>;
      },
    },
    createInvite: {
      name: "create_invite", kind: "write" as const,
      input: Type.Object({ ...workspaceInput, role: roleSchema }),
      output: Type.Object({ token: Type.String(), role: roleSchema, expiresAt: Type.String() }),
      handler: async (context: { userId: string }, input: { workspaceId: string; role: WorkspaceRole }) => {
        await requireWorkspaceRole(db, context.userId, input.workspaceId, "admin");
        const token = `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll("-", "");
        const expiresAt = new Date(now().getTime() + inviteTtlMs);
        await db.insert(workspaceInvites).values({
          workspaceId: input.workspaceId, tokenHash: await sha256(token), role: input.role, createdBy: context.userId, expiresAt,
        });
        return { token, role: input.role, expiresAt: expiresAt.toISOString() };
      },
    },
    acceptInvite: {
      name: "accept_invite", kind: "write" as const,
      input: Type.Object({ token: Type.String({ minLength: 1 }) }),
      output: Type.Object({ workspaceId: Type.String(), slug: Type.String(), role: roleSchema }),
      handler: async (context: { userId: string }, input: { token: string }) => {
        const [invite] = await db.select().from(workspaceInvites).where(eq(workspaceInvites.tokenHash, await sha256(input.token)));
        if (!invite) throw new ActionError("Invite not found", 404);
        if (invite.expiresAt <= now()) throw new ActionError("Invite expired", 410);
        const [workspace] = await db.select({ slug: workspaces.slug }).from(workspaces).where(eq(workspaces.id, invite.workspaceId));
        const inserted = await db.insert(workspaceMembers)
          .values({ workspaceId: invite.workspaceId, userId: context.userId, role: invite.role }).onConflictDoNothing().returning();
        // An existing member keeps their current role: an invite never changes it.
        if (inserted.length > 0) return { workspaceId: invite.workspaceId, slug: workspace!.slug, role: invite.role as WorkspaceRole };
        const [existing] = await db.select({ role: workspaceMembers.role }).from(workspaceMembers)
          .where(and(eq(workspaceMembers.workspaceId, invite.workspaceId), eq(workspaceMembers.userId, context.userId)));
        return { workspaceId: invite.workspaceId, slug: workspace!.slug, role: existing!.role as WorkspaceRole };
      },
    },
    changeMemberRole: {
      name: "change_member_role", kind: "write" as const,
      input: Type.Object({ ...workspaceInput, userId: Type.String(), role: roleSchema }),
      output: memberOutput,
      handler: async (context: { userId: string }, input: { workspaceId: string; userId: string; role: WorkspaceRole }) => {
        await requireWorkspaceRole(db, context.userId, input.workspaceId, "admin");
        return db.transaction(async (tx) => {
          const transaction = tx as unknown as Database;
          const [target] = await transaction.select({ role: workspaceMembers.role }).from(workspaceMembers)
            .where(and(eq(workspaceMembers.workspaceId, input.workspaceId), eq(workspaceMembers.userId, input.userId))).for("update");
          if (!target) throw new ActionError("Member not found", 404);
          if (target.role === "Admin" && input.role !== "Admin" && (await adminCount(transaction, input.workspaceId)) <= 1) {
            throw new ActionError("A workspace needs at least one Admin", 400);
          }
          await transaction.update(workspaceMembers).set({ role: input.role })
            .where(and(eq(workspaceMembers.workspaceId, input.workspaceId), eq(workspaceMembers.userId, input.userId)));
          const [user] = await transaction.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, input.userId));
          return { userId: input.userId, name: user!.name, email: user!.email, role: input.role };
        });
      },
    },
    removeMember: {
      name: "remove_member", kind: "write" as const,
      input: Type.Object({ ...workspaceInput, userId: Type.String() }),
      output: Type.Object({ removed: Type.Boolean() }),
      handler: async (context: { userId: string }, input: { workspaceId: string; userId: string }) => {
        await requireWorkspaceRole(db, context.userId, input.workspaceId, "admin");
        return db.transaction(async (tx) => {
          const transaction = tx as unknown as Database;
          const [target] = await transaction.select({ role: workspaceMembers.role }).from(workspaceMembers)
            .where(and(eq(workspaceMembers.workspaceId, input.workspaceId), eq(workspaceMembers.userId, input.userId))).for("update");
          if (!target) throw new ActionError("Member not found", 404);
          if (target.role === "Admin" && (await adminCount(transaction, input.workspaceId)) <= 1) {
            throw new ActionError("A workspace needs at least one Admin", 400);
          }
          await transaction.delete(workspaceMembers)
            .where(and(eq(workspaceMembers.workspaceId, input.workspaceId), eq(workspaceMembers.userId, input.userId)));
          return { removed: true };
        });
      },
    },
  };
}
