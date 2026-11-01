import { Type } from "@sinclair/typebox";
import { and, asc, eq, isNull, isNotNull, sql } from "drizzle-orm";
import type { Database } from "@weft/db";
import { projectKeyAliases, projectMembers, projects, users, workItemStates, workspaceMembers } from "@weft/db";
import { defaultStates } from "./work-items";
import { triageGroup, triageStateName } from "./triage";
import { featureColumns, featuresOf, featuresPatchSchema, featuresSchema, projectFeatures, type ProjectFeatures } from "./features";
import { ActionError, requireWorkspaceRole, roleLevel, workspaceRoles, type WorkspaceRole } from "./members";

export const projectKeyPattern = /^[A-Z][A-Z0-9]{1,11}$/;
export const projectVisibilities = ["public", "private"] as const;
export type ProjectVisibility = (typeof projectVisibilities)[number];

const roleSchema = Type.Union(workspaceRoles.map((role) => Type.Literal(role)));
const visibilitySchema = Type.Union(projectVisibilities.map((value) => Type.Literal(value)));
const keySchema = Type.String({ pattern: projectKeyPattern.source });
const projectOutput = Type.Object({
  id: Type.String(), key: Type.String(), name: Type.String(), visibility: visibilitySchema,
  archived: Type.Boolean(), role: Type.Union([roleSchema, Type.Null()]), features: featuresSchema,
});
const memberOutput = Type.Object({ userId: Type.String(), name: Type.String(), email: Type.String(), role: roleSchema });
type ProjectOutput = { id: string; key: string; name: string; visibility: ProjectVisibility; archived: boolean; role: WorkspaceRole | null; features: ProjectFeatures };

type Requirement = "read" | "write" | "admin";

/** Project permission layer. Workspace Admins pass every check; a private project looks missing (404) to non-members. */
export async function requireProjectAccess(db: Database, userId: string, projectId: string, requirement: Requirement, options: { allowArchived?: boolean } = {}) {
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!project) throw new ActionError("Project not found", 404);
  const workspaceRole = await requireWorkspaceRole(db, userId, project.workspaceId, "read");
  const [member] = await db.select({ role: projectMembers.role }).from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)));
  const projectRole = (member?.role ?? null) as WorkspaceRole | null;
  const isWorkspaceAdmin = workspaceRole === "Admin";
  if (project.visibility === "private" && !projectRole && !isWorkspaceAdmin) throw new ActionError("Project not found", 404);
  if (requirement !== "read") {
    if (workspaceRole === "Guest") throw new ActionError("Forbidden", 403);
    const needed = requirement === "admin" ? roleLevel.Admin : roleLevel.Member;
    if (!isWorkspaceAdmin && (!projectRole || roleLevel[projectRole] < needed)) throw new ActionError("Forbidden", 403);
    if (project.archivedAt && !options.allowArchived) throw new ActionError("Project is archived", 400);
  }
  return { project, workspaceRole, projectRole };
}

/** The projects of a workspace that a user may read: all of them for a workspace Admin, otherwise the public ones plus the private ones they belong to. A private project never appears for anyone else. */
export async function accessibleProjects(db: Database, userId: string, workspaceId: string) {
  const workspaceRole = await requireWorkspaceRole(db, userId, workspaceId, "read");
  const rows = await db.select().from(projects).where(eq(projects.workspaceId, workspaceId)).orderBy(asc(projects.key));
  if (workspaceRole === "Admin") return rows;
  const mine = new Set((await db.select({ projectId: projectMembers.projectId }).from(projectMembers).where(eq(projectMembers.userId, userId))).map((row) => row.projectId));
  return rows.filter((project) => project.visibility === "public" || mine.has(project.id));
}

function toOutput(project: typeof projects.$inferSelect, role: string | null): ProjectOutput {
  return { id: project.id, key: project.key, name: project.name, visibility: project.visibility as ProjectVisibility, archived: project.archivedAt !== null, role: role as WorkspaceRole | null, features: featuresOf(project) };
}

async function lockWorkspaceKeys(db: Database, workspaceId: string) {
  await db.execute(sql`select pg_advisory_xact_lock(hashtext(${`project-keys:${workspaceId}`}))`);
}

async function assertKeyFree(db: Database, workspaceId: string, key: string, projectId?: string) {
  const [current] = await db.select({ id: projects.id }).from(projects).where(and(eq(projects.workspaceId, workspaceId), eq(projects.key, key)));
  const [alias] = await db.select({ projectId: projectKeyAliases.projectId }).from(projectKeyAliases)
    .where(and(eq(projectKeyAliases.workspaceId, workspaceId), eq(projectKeyAliases.key, key)));
  // A project may take back one of its own old keys.
  if ((current && current.id !== projectId) || (alias && alias.projectId !== projectId)) throw new ActionError("Project key is already taken", 400);
}

export function createProjectActions(db: Database) {
  const workspaceInput = { workspaceId: Type.String({ format: "uuid" }) };
  const projectInput = { projectId: Type.String({ format: "uuid" }) };
  const tx = (transaction: unknown) => transaction as Database;

  async function loadMembers(projectId: string) {
    return await db.select({ userId: users.id, name: users.name, email: users.email, role: projectMembers.role })
      .from(projectMembers).innerJoin(users, eq(users.id, projectMembers.userId))
      .where(eq(projectMembers.projectId, projectId)).orderBy(asc(projectMembers.createdAt), asc(users.id)) as Array<{ userId: string; name: string; email: string; role: WorkspaceRole }>;
  }

  return {
    createProject: {
      name: "create_project", kind: "write" as const,
      input: Type.Object({ ...workspaceInput, name: Type.String({ minLength: 1, maxLength: 100 }), key: keySchema, visibility: visibilitySchema }),
      output: projectOutput,
      handler: async (context: { userId: string }, input: { workspaceId: string; name: string; key: string; visibility: ProjectVisibility }) => {
        await requireWorkspaceRole(db, context.userId, input.workspaceId, "write");
        if (!projectKeyPattern.test(input.key)) throw new ActionError("Invalid project key", 400);
        return db.transaction(async (transaction) => {
          const database = tx(transaction);
          await lockWorkspaceKeys(database, input.workspaceId);
          await assertKeyFree(database, input.workspaceId, input.key);
          const [project] = await database.insert(projects).values({ ...input, createdBy: context.userId }).returning();
          await database.insert(projectMembers).values({ workspaceId: input.workspaceId, projectId: project!.id, userId: context.userId, role: "Admin" });
          await database.insert(workItemStates).values(defaultStates.map((state, index) => ({ workspaceId: input.workspaceId, projectId: project!.id, name: state.name, group: state.group, sortOrder: index })));
          await database.insert(workItemStates).values({ workspaceId: input.workspaceId, projectId: project!.id, name: triageStateName, group: triageGroup, sortOrder: defaultStates.length });
          return toOutput(project!, "Admin");
        });
      },
    },
    listProjects: {
      name: "list_projects", kind: "read" as const,
      input: Type.Object({ ...workspaceInput, archived: Type.Optional(Type.Boolean()) }),
      output: Type.Array(projectOutput),
      handler: async (context: { userId: string }, input: { workspaceId: string; archived?: boolean }) => {
        const workspaceRole = await requireWorkspaceRole(db, context.userId, input.workspaceId, "read");
        const rows = await db.select({ project: projects, role: projectMembers.role }).from(projects)
          .leftJoin(projectMembers, and(eq(projectMembers.projectId, projects.id), eq(projectMembers.userId, context.userId)))
          .where(and(eq(projects.workspaceId, input.workspaceId), input.archived ? isNotNull(projects.archivedAt) : isNull(projects.archivedAt)))
          .orderBy(asc(projects.key));
        return rows.filter((row) => workspaceRole === "Admin" || row.project.visibility === "public" || row.role !== null).map((row) => toOutput(row.project, row.role));
      },
    },
    getProject: {
      name: "get_project", kind: "read" as const,
      input: Type.Object({ ...workspaceInput, key: Type.String({ minLength: 1 }) }),
      output: Type.Intersect([projectOutput, Type.Object({ requestedKey: Type.String(), viaAlias: Type.Boolean() })]),
      handler: async (context: { userId: string }, input: { workspaceId: string; key: string }) => {
        await requireWorkspaceRole(db, context.userId, input.workspaceId, "read");
        const key = input.key.toUpperCase();
        let [project] = await db.select().from(projects).where(and(eq(projects.workspaceId, input.workspaceId), eq(projects.key, key)));
        let viaAlias = false;
        if (!project) {
          const [alias] = await db.select({ projectId: projectKeyAliases.projectId }).from(projectKeyAliases)
            .where(and(eq(projectKeyAliases.workspaceId, input.workspaceId), eq(projectKeyAliases.key, key)));
          if (alias) { [project] = await db.select().from(projects).where(eq(projects.id, alias.projectId)); viaAlias = true; }
        }
        if (!project) throw new ActionError("Project not found", 404);
        const access = await requireProjectAccess(db, context.userId, project.id, "read");
        return { ...toOutput(project, access.projectRole), requestedKey: key, viaAlias };
      },
    },
    updateProject: {
      name: "update_project", kind: "write" as const,
      input: Type.Object({ ...projectInput, name: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })), visibility: Type.Optional(visibilitySchema) }),
      output: projectOutput,
      handler: async (context: { userId: string }, input: { projectId: string; name?: string; visibility?: ProjectVisibility }) => {
        const { project, projectRole } = await requireProjectAccess(db, context.userId, input.projectId, "admin");
        const [updated] = await db.update(projects).set({ name: input.name ?? project.name, visibility: input.visibility ?? project.visibility })
          .where(eq(projects.id, project.id)).returning();
        return toOutput(updated!, projectRole);
      },
    },
    setProjectFeatures: {
      name: "set_project_features", kind: "write" as const,
      input: Type.Object({ ...projectInput, features: featuresPatchSchema }), output: projectOutput,
      handler: async (context: { userId: string }, input: { projectId: string; features: Partial<ProjectFeatures> }) => {
        const { project, projectRole } = await requireProjectAccess(db, context.userId, input.projectId, "admin");
        const patch = Object.fromEntries(projectFeatures.filter((feature) => typeof input.features[feature] === "boolean").map((feature) => [featureColumns[feature], input.features[feature]]));
        if (Object.keys(patch).length === 0) return toOutput(project, projectRole);
        const [updated] = await db.update(projects).set(patch).where(eq(projects.id, project.id)).returning();
        return toOutput(updated!, projectRole);
      },
    },
    renameProjectKey: {
      name: "rename_project_key", kind: "write" as const,
      input: Type.Object({ ...projectInput, key: keySchema }),
      output: projectOutput,
      handler: async (context: { userId: string }, input: { projectId: string; key: string }) => {
        const { project, projectRole } = await requireProjectAccess(db, context.userId, input.projectId, "admin");
        if (!projectKeyPattern.test(input.key)) throw new ActionError("Invalid project key", 400);
        if (input.key === project.key) return toOutput(project, projectRole);
        return db.transaction(async (transaction) => {
          const database = tx(transaction);
          await lockWorkspaceKeys(database, project.workspaceId);
          await assertKeyFree(database, project.workspaceId, input.key, project.id);
          // Taking back an old key removes it from the aliases so the key stays unique.
          await database.delete(projectKeyAliases).where(and(eq(projectKeyAliases.workspaceId, project.workspaceId), eq(projectKeyAliases.key, input.key)));
          await database.insert(projectKeyAliases).values({ workspaceId: project.workspaceId, projectId: project.id, key: project.key });
          const [updated] = await database.update(projects).set({ key: input.key }).where(eq(projects.id, project.id)).returning();
          return toOutput(updated!, projectRole);
        });
      },
    },
    archiveProject: {
      name: "archive_project", kind: "write" as const,
      input: Type.Object(projectInput), output: projectOutput,
      handler: async (context: { userId: string }, input: { projectId: string }) => {
        const { project, projectRole } = await requireProjectAccess(db, context.userId, input.projectId, "admin", { allowArchived: true });
        const [updated] = await db.update(projects).set({ archivedAt: project.archivedAt ?? new Date() }).where(eq(projects.id, project.id)).returning();
        return toOutput(updated!, projectRole);
      },
    },
    unarchiveProject: {
      name: "unarchive_project", kind: "write" as const,
      input: Type.Object(projectInput), output: projectOutput,
      handler: async (context: { userId: string }, input: { projectId: string }) => {
        const { project, projectRole } = await requireProjectAccess(db, context.userId, input.projectId, "admin", { allowArchived: true });
        const [updated] = await db.update(projects).set({ archivedAt: null }).where(eq(projects.id, project.id)).returning();
        return toOutput(updated!, projectRole);
      },
    },
    joinProject: {
      name: "join_project", kind: "write" as const,
      input: Type.Object(projectInput), output: projectOutput,
      handler: async (context: { userId: string }, input: { projectId: string }) => {
        const [project] = await db.select().from(projects).where(eq(projects.id, input.projectId));
        if (!project) throw new ActionError("Project not found", 404);
        const workspaceRole = await requireWorkspaceRole(db, context.userId, project.workspaceId, "read");
        if (project.visibility !== "public") throw new ActionError("Project not found", 404);
        if (project.archivedAt) throw new ActionError("Project is archived", 400);
        const role: WorkspaceRole = workspaceRole === "Guest" ? "Guest" : "Member";
        await db.insert(projectMembers).values({ workspaceId: project.workspaceId, projectId: project.id, userId: context.userId, role }).onConflictDoNothing();
        const [row] = await db.select({ role: projectMembers.role }).from(projectMembers)
          .where(and(eq(projectMembers.projectId, project.id), eq(projectMembers.userId, context.userId)));
        return toOutput(project, row!.role);
      },
    },
    listProjectMembers: {
      name: "list_project_members", kind: "read" as const,
      input: Type.Object(projectInput), output: Type.Array(memberOutput),
      handler: async (context: { userId: string }, input: { projectId: string }) => {
        await requireProjectAccess(db, context.userId, input.projectId, "read");
        return loadMembers(input.projectId);
      },
    },
    addProjectMember: {
      name: "add_project_member", kind: "write" as const,
      input: Type.Object({ ...projectInput, userId: Type.String(), role: roleSchema }), output: memberOutput,
      handler: async (context: { userId: string }, input: { projectId: string; userId: string; role: WorkspaceRole }) => {
        const { project } = await requireProjectAccess(db, context.userId, input.projectId, "admin");
        const [target] = await db.select({ role: workspaceMembers.role }).from(workspaceMembers)
          .where(and(eq(workspaceMembers.workspaceId, project.workspaceId), eq(workspaceMembers.userId, input.userId)));
        if (!target) throw new ActionError("User is not a workspace member", 400);
        await db.insert(projectMembers).values({ workspaceId: project.workspaceId, projectId: project.id, userId: input.userId, role: input.role })
          .onConflictDoUpdate({ target: [projectMembers.projectId, projectMembers.userId], set: { role: input.role } });
        return (await loadMembers(project.id)).find((member) => member.userId === input.userId)!;
      },
    },
    changeProjectMemberRole: {
      name: "change_project_member_role", kind: "write" as const,
      input: Type.Object({ ...projectInput, userId: Type.String(), role: roleSchema }), output: memberOutput,
      handler: async (context: { userId: string }, input: { projectId: string; userId: string; role: WorkspaceRole }) => {
        await requireProjectAccess(db, context.userId, input.projectId, "admin");
        return db.transaction(async (transaction) => {
          const database = tx(transaction);
          const members = await database.select().from(projectMembers).where(eq(projectMembers.projectId, input.projectId)).for("update");
          const target = members.find((member) => member.userId === input.userId);
          if (!target) throw new ActionError("Member not found", 404);
          if (target.role === "Admin" && input.role !== "Admin" && members.filter((member) => member.role === "Admin").length <= 1) {
            throw new ActionError("A project needs at least one Admin", 400);
          }
          await database.update(projectMembers).set({ role: input.role }).where(eq(projectMembers.id, target.id));
          const [user] = await database.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, input.userId));
          return { userId: input.userId, name: user!.name, email: user!.email, role: input.role };
        });
      },
    },
    removeProjectMember: {
      name: "remove_project_member", kind: "write" as const,
      input: Type.Object({ ...projectInput, userId: Type.String() }), output: Type.Object({ removed: Type.Boolean() }),
      handler: async (context: { userId: string }, input: { projectId: string; userId: string }) => {
        await requireProjectAccess(db, context.userId, input.projectId, "admin");
        return db.transaction(async (transaction) => {
          const database = tx(transaction);
          const members = await database.select().from(projectMembers).where(eq(projectMembers.projectId, input.projectId)).for("update");
          const target = members.find((member) => member.userId === input.userId);
          if (!target) throw new ActionError("Member not found", 404);
          if (target.role === "Admin" && members.filter((member) => member.role === "Admin").length <= 1) {
            throw new ActionError("A project needs at least one Admin", 400);
          }
          await database.delete(projectMembers).where(eq(projectMembers.id, target.id));
          return { removed: true };
        });
      },
    },
  };
}
