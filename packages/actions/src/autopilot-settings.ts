import { Type } from "@sinclair/typebox";
import { eq } from "drizzle-orm";
import type { Database } from "@weft/db";
import { agents, aiChats, workspaces } from "@weft/db";
import { ActionError, requireWorkspaceRole } from "./members";

export function createAutopilotSettingActions(db: Database) {
  const input = Type.Object({ workspaceId: Type.String({ format: "uuid" }) });
  return {
    getAutopilotSetting: {
      name: "get_autopilot_setting", kind: "read" as const, input,
      output: Type.Object({ allowAutopilot: Type.Boolean() }),
      handler: async (context: { userId: string }, value: { workspaceId: string }) => {
        await requireWorkspaceRole(db, context.userId, value.workspaceId, "read");
        const [workspace] = await db.select({ allowAutopilot: workspaces.allowAutopilot }).from(workspaces).where(eq(workspaces.id, value.workspaceId));
        if (!workspace) throw new ActionError("Workspace not found", 404);
        return workspace;
      },
    },
    setAutopilotSetting: {
      name: "set_autopilot_setting", kind: "write" as const,
      input: Type.Object({ workspaceId: Type.String({ format: "uuid" }), allowAutopilot: Type.Boolean() }),
      output: Type.Object({ allowAutopilot: Type.Boolean() }),
      handler: async (context: { userId: string }, value: { workspaceId: string; allowAutopilot: boolean }) => {
        await requireWorkspaceRole(db, context.userId, value.workspaceId, "admin");
        const [workspace] = await db.update(workspaces).set({ allowAutopilot: value.allowAutopilot }).where(eq(workspaces.id, value.workspaceId)).returning({ allowAutopilot: workspaces.allowAutopilot });
        if (!workspace) throw new ActionError("Workspace not found", 404);
        if (!value.allowAutopilot) {
          await db.update(aiChats).set({ mode: "build" }).where(eq(aiChats.workspaceId, value.workspaceId));
          await db.update(agents).set({ autopilot: false }).where(eq(agents.workspaceId, value.workspaceId));
        }
        return workspace;
      },
    },
  };
}
