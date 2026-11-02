import { and, eq, inArray } from "drizzle-orm";
import type { Database } from "@weft/db";
import { agentProjects, agents, projectMembers, projects, users } from "@weft/db";

/** System ceilings for the per-run limits an admin may set on an Agent (spec "Limits"). */
export const agentLimitDefaults = { maxToolCalls: 25, maxTokens: 200_000, timeoutSeconds: 600 } as const;
export const agentLimitCeilings = { maxToolCalls: 100, maxTokens: 1_000_000, timeoutSeconds: 3600 } as const;

/** Bot user ids of Agents that are currently disabled, among `userIds`. */
export async function disabledAgentUserIds(db: Database, userIds: string[]) {
  if (userIds.length === 0) return new Set<string>();
  const rows = await db.select({ userId: agents.userId }).from(agents).where(and(inArray(agents.userId, userIds), eq(agents.enabled, false)));
  return new Set(rows.map((row) => row.userId));
}

/** Bot user ids among `userIds`, enabled or not. */
export async function agentUserIds(db: Database, userIds: string[]) {
  if (userIds.length === 0) return new Set<string>();
  const rows = await db.select({ id: users.id }).from(users).where(and(inArray(users.id, userIds), eq(users.isAgent, true)));
  return new Set(rows.map((row) => row.id));
}

/** Drops disabled Agents from a list of people, for pickers and mention lists. */
export async function withoutDisabledAgents<T extends { userId: string }>(db: Database, rows: T[]): Promise<T[]> {
  const disabled = await disabledAgentUserIds(db, rows.map((row) => row.userId));
  return disabled.size === 0 ? rows : rows.filter((row) => !disabled.has(row.userId));
}

/** Reconciles an Agent's project memberships with its access setting: open projects gain the bot user as a Member, closed ones lose it. */
export async function syncAgentProjects(db: Database, agent: Pick<typeof agents.$inferSelect, "id" | "workspaceId" | "userId" | "allProjects">) {
  const workspaceProjects = await db.select({ id: projects.id }).from(projects).where(eq(projects.workspaceId, agent.workspaceId));
  const chosen = new Set((await db.select({ projectId: agentProjects.projectId }).from(agentProjects).where(eq(agentProjects.agentId, agent.id))).map((row) => row.projectId));
  const wanted = workspaceProjects.map((project) => project.id).filter((id) => agent.allProjects || chosen.has(id));
  if (wanted.length > 0) {
    await db.insert(projectMembers).values(wanted.map((projectId) => ({ workspaceId: agent.workspaceId, projectId, userId: agent.userId, role: "Member" }))).onConflictDoNothing();
  }
  const current = await db.select({ projectId: projectMembers.projectId }).from(projectMembers)
    .where(and(eq(projectMembers.workspaceId, agent.workspaceId), eq(projectMembers.userId, agent.userId)));
  const stale = current.map((row) => row.projectId).filter((id) => !wanted.includes(id));
  if (stale.length > 0) await db.delete(projectMembers).where(and(eq(projectMembers.userId, agent.userId), inArray(projectMembers.projectId, stale)));
}

/** Opens a freshly created project to every Agent that is open to all projects. */
export async function openProjectToAllProjectAgents(db: Database, project: { id: string; workspaceId: string }) {
  const open = await db.select({ userId: agents.userId }).from(agents).where(and(eq(agents.workspaceId, project.workspaceId), eq(agents.allProjects, true)));
  if (open.length === 0) return;
  await db.insert(projectMembers).values(open.map((agent) => ({ workspaceId: project.workspaceId, projectId: project.id, userId: agent.userId, role: "Member" }))).onConflictDoNothing();
}
