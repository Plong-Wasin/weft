import { AsyncLocalStorage } from "node:async_hooks";
import { and, eq } from "drizzle-orm";
import type { Database } from "@weft/db";
import { projectMembers } from "@weft/db";

export type AgentProjectScope = { agentUserId: string; workspaceId: string };

const scope = new AsyncLocalStorage<AgentProjectScope>();

export function withAgentProjectScope<T>(value: AgentProjectScope, action: () => T): T {
  return scope.run(value, action);
}

export function currentAgentProjectScope() {
  return scope.getStore();
}

/** Project ids available to this Agent in its Run workspace, or null outside an Agent Run. */
export async function agentProjectIds(db: Database, workspaceId: string): Promise<Set<string> | null> {
  const current = scope.getStore();
  if (!current) return null;
  if (workspaceId !== current.workspaceId) return new Set();
  const rows = await db.select({ projectId: projectMembers.projectId }).from(projectMembers)
    .where(and(eq(projectMembers.workspaceId, current.workspaceId), eq(projectMembers.userId, current.agentUserId)));
  return new Set(rows.map((row) => row.projectId));
}
