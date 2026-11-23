import { and, eq, inArray } from "drizzle-orm";
import type { Database } from "@weft/db";
import { moduleMembers, modules, projectMembers, projects, workspaceMembers } from "@weft/db";

/** Drops Module roles only when the user no longer passes Modules' assertPeople rule. */
export async function clearModuleRoles(db: Database, input: { userId: string; projectIds: string[] }) {
  if (input.projectIds.length === 0) return;
  const workspaceAdmins = await db.select({ projectId: projects.id }).from(projects).innerJoin(workspaceMembers, and(
    eq(workspaceMembers.workspaceId, projects.workspaceId), eq(workspaceMembers.userId, input.userId), eq(workspaceMembers.role, "Admin"),
  )).where(inArray(projects.id, input.projectIds));
  const adminProjects = new Set(workspaceAdmins.map((row) => row.projectId));
  const projectAccess = await db.select({ projectId: projectMembers.projectId }).from(projectMembers)
    .where(and(inArray(projectMembers.projectId, input.projectIds), eq(projectMembers.userId, input.userId), inArray(projectMembers.role, ["Admin", "Member"])));
  const retained = new Set(projectAccess.map((row) => row.projectId));
  const candidates = input.projectIds.filter((projectId) => !adminProjects.has(projectId) && !retained.has(projectId));
  if (candidates.length === 0) return;
  const projectModules = db.select({ id: modules.id }).from(modules).where(inArray(modules.projectId, candidates));
  await db.update(modules).set({ leadId: null }).where(and(inArray(modules.projectId, candidates), eq(modules.leadId, input.userId)));
  await db.delete(moduleMembers).where(and(inArray(moduleMembers.moduleId, projectModules), eq(moduleMembers.userId, input.userId)));
}
