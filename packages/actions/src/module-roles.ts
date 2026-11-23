import { and, eq, inArray } from "drizzle-orm";
import type { Database } from "@weft/db";
import { moduleMembers, modules, projectMembers, projects, workspaceMembers } from "@weft/db";

/** Returns the user/project pairs allowed by Modules' shared lead/member rule. */
export async function eligibleModuleRolePairs(db: Database, input: { projectIds: string[]; userIds: string[] }) {
  const pairs = new Set<string>();
  if (input.projectIds.length === 0 || input.userIds.length === 0) return pairs;
  const admins = await db.select({ projectId: projects.id, userId: workspaceMembers.userId }).from(projects).innerJoin(workspaceMembers, and(
    eq(workspaceMembers.workspaceId, projects.workspaceId), eq(workspaceMembers.role, "Admin"),
  )).where(and(inArray(projects.id, input.projectIds), inArray(workspaceMembers.userId, input.userIds)));
  for (const row of admins) pairs.add(`${row.projectId}:${row.userId}`);
  const writableMembers = await db.select({ projectId: projectMembers.projectId, userId: projectMembers.userId }).from(projectMembers)
    .innerJoin(projects, eq(projects.id, projectMembers.projectId)).innerJoin(workspaceMembers, and(
      eq(workspaceMembers.workspaceId, projects.workspaceId), eq(workspaceMembers.userId, projectMembers.userId),
    )).where(and(
      inArray(projectMembers.projectId, input.projectIds), inArray(projectMembers.userId, input.userIds),
      inArray(projectMembers.role, ["Admin", "Member"]), inArray(workspaceMembers.role, ["Admin", "Member"]),
    ));
  for (const row of writableMembers) pairs.add(`${row.projectId}:${row.userId}`);
  return pairs;
}

/** Drops Module roles only when the user no longer passes Modules' assertPeople rule. */
export async function clearModuleRoles(db: Database, input: { userId: string; projectIds: string[] }) {
  if (input.projectIds.length === 0) return;
  const retained = await eligibleModuleRolePairs(db, { projectIds: input.projectIds, userIds: [input.userId] });
  const candidates = input.projectIds.filter((projectId) => !retained.has(`${projectId}:${input.userId}`));
  if (candidates.length === 0) return;
  const projectModules = db.select({ id: modules.id }).from(modules).where(inArray(modules.projectId, candidates));
  await db.update(modules).set({ leadId: null }).where(and(inArray(modules.projectId, candidates), eq(modules.leadId, input.userId)));
  await db.delete(moduleMembers).where(and(inArray(moduleMembers.moduleId, projectModules), eq(moduleMembers.userId, input.userId)));
}
