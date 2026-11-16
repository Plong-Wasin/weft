import { Type } from "@sinclair/typebox";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "@weft/db";
import { projectPreferences } from "@weft/db";
import { ActionError, requireWorkspaceRole } from "./members";
import { accessibleProjects, requireProjectAccess } from "./projects";

const preferenceOutput = Type.Object({
  projectId: Type.String(),
  starred: Type.Boolean(),
  /** Place in this person's order; null when the project was never ordered (it sorts after the ordered ones, by name). */
  position: Type.Union([Type.Integer(), Type.Null()]),
  expanded: Type.Boolean(),
});

type PreferenceRow = typeof projectPreferences.$inferSelect;
const toOutput = (row: PreferenceRow) => ({ projectId: row.projectId, starred: row.starred, position: row.position, expanded: row.expanded });

/**
 * Per-person sidebar state for projects: stars, order and the expanded menu. Each person has their own rows, so one person's
 * order never changes another's. Only projects the caller may read appear here.
 */
export function createProjectPreferenceActions(db: Database) {
  const workspaceInput = Type.Object({ workspaceId: Type.String({ format: "uuid" }) });

  async function visibleProjectIds(userId: string, workspaceId: string) {
    return (await accessibleProjects(db, userId, workspaceId)).map((project) => project.id);
  }

  async function listFor(userId: string, projectIds: string[]) {
    if (projectIds.length === 0) return [];
    const rows = await db.select().from(projectPreferences)
      .where(and(eq(projectPreferences.userId, userId), inArray(projectPreferences.projectId, projectIds)));
    return rows.map(toOutput);
  }

  return {
    listProjectPreferences: {
      name: "list_project_preferences", kind: "read" as const,
      input: workspaceInput,
      output: Type.Array(preferenceOutput),
      handler: async (context: { userId: string }, input: { workspaceId: string }) => {
        return await listFor(context.userId, await visibleProjectIds(context.userId, input.workspaceId));
      },
    },
    setProjectPreference: {
      name: "set_project_preference", kind: "write" as const,
      input: Type.Object({ projectId: Type.String({ format: "uuid" }), starred: Type.Optional(Type.Boolean()), expanded: Type.Optional(Type.Boolean()) }),
      output: preferenceOutput,
      handler: async (context: { userId: string }, input: { projectId: string; starred?: boolean; expanded?: boolean }) => {
        await requireProjectAccess(db, context.userId, input.projectId, "read");
        const changes: Partial<PreferenceRow> = { updatedAt: new Date() };
        if (input.starred !== undefined) changes.starred = input.starred;
        if (input.expanded !== undefined) changes.expanded = input.expanded;
        const [row] = await db.insert(projectPreferences).values({ userId: context.userId, projectId: input.projectId, starred: input.starred ?? false, expanded: input.expanded ?? false })
          .onConflictDoUpdate({ target: [projectPreferences.userId, projectPreferences.projectId], set: changes })
          .returning();
        return toOutput(row!);
      },
    },
    /** Sets the caller's whole order over the workspace projects they can read. Listed projects take their index; the rest go back to "never ordered". */
    setProjectOrder: {
      name: "set_project_order", kind: "write" as const,
      input: Type.Object({ workspaceId: Type.String({ format: "uuid" }), projectIds: Type.Array(Type.String({ format: "uuid" })) }),
      output: Type.Array(preferenceOutput),
      handler: async (context: { userId: string }, input: { workspaceId: string; projectIds: string[] }) => {
        const visible = await visibleProjectIds(context.userId, input.workspaceId);
        const visibleSet = new Set(visible);
        if (new Set(input.projectIds).size !== input.projectIds.length) throw new ActionError("A project appears twice in the order", 400);
        if (input.projectIds.some((id) => !visibleSet.has(id))) throw new ActionError("Project not found", 404);
        if (visible.length === 0) return [];
        const positions = new Map(input.projectIds.map((id, index) => [id, index]));
        const now = new Date();
        await db.insert(projectPreferences).values(visible.map((projectId) => ({ userId: context.userId, projectId, position: positions.get(projectId) ?? null, updatedAt: now })))
          .onConflictDoUpdate({ target: [projectPreferences.userId, projectPreferences.projectId], set: { position: sql`excluded.position`, updatedAt: now } });
        return await listFor(context.userId, visible);
      },
    },
    /** Puts every project back to the default: never ordered, so by name. Stars and expanded menus stay. */
    resetProjectOrder: {
      name: "reset_project_order", kind: "write" as const,
      input: workspaceInput,
      output: Type.Array(preferenceOutput),
      handler: async (context: { userId: string }, input: { workspaceId: string }) => {
        await requireWorkspaceRole(db, context.userId, input.workspaceId, "read");
        const visible = await visibleProjectIds(context.userId, input.workspaceId);
        if (visible.length === 0) return [];
        await db.update(projectPreferences).set({ position: null, updatedAt: new Date() })
          .where(and(eq(projectPreferences.userId, context.userId), inArray(projectPreferences.projectId, visible)));
        return await listFor(context.userId, visible);
      },
    },
  };
}
