import type { Database } from "@weft/db";
import { activities } from "@weft/db";

/** Record an administrative change in the workspace activity log; the admin console's audit page reads these rows. */
export async function auditAgentChange(database: Database, input: {
  workspaceId: string; entityType: "agent" | "runtime" | "trigger" | "skill" | "workspace" | "member" | "api_token";
  entityId: string; field: string; oldValue: unknown; newValue: unknown;
  /** Null when the system made the change: the row then has source system and no actor. */
  actorId: string | null;
}) {
  await database.insert(activities).values({
    workspaceId: input.workspaceId, entityType: input.entityType, entityId: input.entityId,
    field: input.field, oldValue: input.oldValue, newValue: input.newValue,
    actorId: input.actorId, source: input.actorId === null ? "system" : "ui",
  });
}
