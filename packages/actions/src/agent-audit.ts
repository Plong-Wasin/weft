import type { Database } from "@weft/db";
import { activities } from "@weft/db";

/** Record an administrative change in the workspace activity log. */
export async function auditAgentChange(database: Database, input: {
  workspaceId: string; entityType: "agent" | "runtime" | "trigger" | "skill" | "workspace";
  entityId: string; field: string; oldValue: unknown; newValue: unknown; actorId: string;
}) {
  await database.insert(activities).values({
    workspaceId: input.workspaceId, entityType: input.entityType, entityId: input.entityId,
    field: input.field, oldValue: input.oldValue, newValue: input.newValue,
    actorId: input.actorId, source: "ui",
  });
}
