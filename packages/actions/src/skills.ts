import { Type } from "@sinclair/typebox";
import { and, asc, eq, isNull, ne, or } from "drizzle-orm";
import type { Database } from "@weft/db";
import { agentSkills, agents, skills, users } from "@weft/db";
import { ActionError, requireWorkspaceRole } from "./members";
import { auditAgentChange } from "./agent-audit";

const uuid = () => Type.String({ format: "uuid" });
const scopeSchema = Type.Union([Type.Literal("personal"), Type.Literal("workspace")]);
const nameSchema = Type.String({ minLength: 1, maxLength: 64, pattern: "^[a-z0-9]+(-[a-z0-9]+)*$" });
const descriptionSchema = Type.String({ minLength: 1, maxLength: 1024 });
const instructionsSchema = Type.String({ minLength: 1, maxLength: 8000 });
const summaryOutput = Type.Object({ id: uuid(), name: Type.String(), description: Type.String(), scope: scopeSchema });
const skillOutput = Type.Composite([summaryOutput, Type.Object({ instructions: Type.String() })]);
const skillDetailOutput = Type.Composite([skillOutput, Type.Object({ workspaceId: uuid() })]);

type SkillScope = "personal" | "workspace";
type SkillRow = typeof skills.$inferSelect;

export function createSkillActions(db: Database) {
  async function accessible(context: { userId: string }, skillId: string): Promise<SkillRow> {
    const [row] = await db.select().from(skills).where(eq(skills.id, skillId));
    if (!row) throw new ActionError("Skill not found", 404);
    await requireWorkspaceRole(db, context.userId, row.workspaceId, "read");
    if (row.scope === "personal" && row.ownerId !== context.userId) throw new ActionError("Skill not found", 404);
    return row;
  }

  async function writable(context: { userId: string }, skillId: string): Promise<SkillRow> {
    const row = await accessible(context, skillId);
    if (row.scope === "personal") {
      if (row.ownerId !== context.userId) throw new ActionError("Skill not found", 404);
    } else {
      await requireWorkspaceRole(db, context.userId, row.workspaceId, "admin");
    }
    return row;
  }

  async function ensureNameAvailable(workspaceId: string, scope: SkillScope, ownerId: string | null, name: string, exceptId?: string) {
    const rows = await db.select({ id: skills.id }).from(skills).where(and(
      eq(skills.workspaceId, workspaceId), eq(skills.scope, scope), eq(skills.name, name),
      scope === "personal" ? eq(skills.ownerId, ownerId!) : isNull(skills.ownerId),
      ...(exceptId ? [ne(skills.id, exceptId)] : []),
    )).limit(1);
    if (rows.length) throw new ActionError("A Skill with this name already exists in this scope", 409);
  }

  function duplicate(error: unknown): never {
    const cause = (error as { cause?: { code?: string } })?.cause;
    if ((error as { code?: string })?.code === "23505" || cause?.code === "23505") throw new ActionError("A Skill with this name already exists in this scope", 409);
    throw error;
  }

  return {
    listSkills: {
      name: "list_skills", kind: "read" as const,
      input: Type.Object({ workspaceId: uuid() }), output: Type.Array(summaryOutput),
      handler: async (context: { userId: string }, input: { workspaceId: string }) => {
        const role = await requireWorkspaceRole(db, context.userId, input.workspaceId, "read");
        const rows = await db.select({ id: skills.id, name: skills.name, description: skills.description, scope: skills.scope })
          .from(skills).where(and(eq(skills.workspaceId, input.workspaceId), or(eq(skills.scope, "workspace"), and(eq(skills.scope, "personal"), eq(skills.ownerId, context.userId)))))
          .orderBy(asc(skills.scope), asc(skills.name), asc(skills.id));
        return rows.map((row) => ({ ...row, scope: row.scope as SkillScope }));
      },
    },
    getSkill: {
      name: "get_skill", kind: "read" as const,
      input: Type.Object({ skillId: uuid() }), output: skillDetailOutput,
      handler: async (context: { userId: string }, input: { skillId: string }) => {
        const row = await accessible(context, input.skillId);
        return { workspaceId: row.workspaceId, id: row.id, name: row.name, description: row.description, scope: row.scope as SkillScope, instructions: row.instructions };
      },
    },
    listSkillAgents: {
      name: "list_skill_agents", kind: "read" as const,
      input: Type.Object({ skillId: uuid() }), output: Type.Array(Type.Object({ id: uuid(), name: Type.String() })),
      handler: async (context: { userId: string }, input: { skillId: string }) => {
        const row = await accessible(context, input.skillId);
        if (row.scope !== "workspace") throw new ActionError("Only Workspace Skills can be attached to Agents", 400);
        await requireWorkspaceRole(db, context.userId, row.workspaceId, "admin");
        return db.select({ id: agents.id, name: users.name }).from(agentSkills)
          .innerJoin(agents, eq(agentSkills.agentId, agents.id)).innerJoin(users, eq(agents.userId, users.id))
          .where(eq(agentSkills.skillId, row.id)).orderBy(asc(users.name), asc(agents.id));
      },
    },
    createSkill: {
      name: "create_skill", kind: "write" as const,
      input: Type.Object({ workspaceId: uuid(), scope: scopeSchema, name: nameSchema, description: descriptionSchema, instructions: instructionsSchema }), output: skillOutput,
      handler: async (context: { userId: string }, input: { workspaceId: string; scope: SkillScope; name: string; description: string; instructions: string }) => {
        await requireWorkspaceRole(db, context.userId, input.workspaceId, input.scope === "workspace" ? "admin" : "write");
        await ensureNameAvailable(input.workspaceId, input.scope, input.scope === "personal" ? context.userId : null, input.name);
        try {
          const [row] = await db.insert(skills).values({ ...input, ownerId: input.scope === "personal" ? context.userId : null }).returning();
          await auditAgentChange(db, { workspaceId: input.workspaceId, entityType: "skill", entityId: row!.id, field: "created", oldValue: null, newValue: { name: row!.name, scope: row!.scope }, actorId: context.userId });
          return { id: row!.id, name: row!.name, description: row!.description, scope: row!.scope as SkillScope, instructions: row!.instructions };
        } catch (error) { duplicate(error); }
      },
    },
    updateSkill: {
      name: "update_skill", kind: "write" as const,
      input: Type.Object({ skillId: uuid(), name: Type.Optional(nameSchema), description: Type.Optional(descriptionSchema), instructions: Type.Optional(instructionsSchema) }), output: skillOutput,
      handler: async (context: { userId: string }, input: { skillId: string; name?: string; description?: string; instructions?: string }) => {
        const row = await writable(context, input.skillId);
        if (input.name === undefined && input.description === undefined && input.instructions === undefined) throw new ActionError("Provide at least one Skill field to update", 400);
        if (input.name !== undefined) await ensureNameAvailable(row.workspaceId, row.scope as SkillScope, row.ownerId, input.name, row.id);
        try {
          const [updated] = await db.update(skills).set({
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.description !== undefined ? { description: input.description } : {}),
            ...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
            updatedAt: new Date(),
          }).where(eq(skills.id, row.id)).returning();
          await auditAgentChange(db, { workspaceId: row.workspaceId, entityType: "skill", entityId: row.id, field: "updated", oldValue: { name: row.name, description: row.description, instructions: row.instructions }, newValue: { name: updated!.name, description: updated!.description, instructions: updated!.instructions }, actorId: context.userId });
          return { id: updated!.id, name: updated!.name, description: updated!.description, scope: updated!.scope as SkillScope, instructions: updated!.instructions };
        } catch (error) { duplicate(error); }
      },
    },
    deleteSkill: {
      name: "delete_skill", kind: "write" as const,
      input: Type.Object({ skillId: uuid() }), output: Type.Object({ deleted: Type.Boolean() }),
      handler: async (context: { userId: string }, input: { skillId: string }) => {
        const row = await writable(context, input.skillId);
        await db.delete(skills).where(eq(skills.id, row.id));
        await auditAgentChange(db, { workspaceId: row.workspaceId, entityType: "skill", entityId: row.id, field: "deleted", oldValue: { name: row.name, scope: row.scope }, newValue: null, actorId: context.userId });
        return { deleted: true };
      },
    },
  };
}
