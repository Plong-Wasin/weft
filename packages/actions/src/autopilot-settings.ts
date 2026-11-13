import { Type } from "@sinclair/typebox";
import { eq } from "drizzle-orm";
import type { Database } from "@weft/db";
import { agents, aiChats, workspaces } from "@weft/db";
import { ActionError, requireWorkspaceRole } from "./members";
import { auditAgentChange } from "./agent-audit";

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
        const [before] = await db.select({ allowAutopilot: workspaces.allowAutopilot }).from(workspaces).where(eq(workspaces.id, value.workspaceId));
        const [workspace] = await db.update(workspaces).set({ allowAutopilot: value.allowAutopilot }).where(eq(workspaces.id, value.workspaceId)).returning({ allowAutopilot: workspaces.allowAutopilot });
        if (!workspace) throw new ActionError("Workspace not found", 404);
        if (before?.allowAutopilot !== workspace.allowAutopilot) await auditAgentChange(db, { workspaceId: value.workspaceId, entityType: "workspace", entityId: value.workspaceId, field: "autopilot", oldValue: before?.allowAutopilot, newValue: workspace.allowAutopilot, actorId: context.userId });
        if (!value.allowAutopilot) {
          await db.update(aiChats).set({ mode: "build" }).where(eq(aiChats.workspaceId, value.workspaceId));
          await db.update(agents).set({ autopilot: false }).where(eq(agents.workspaceId, value.workspaceId));
        }
        return workspace;
      },
    },
    getRuntimeRunLimits: {
      name: "get_runtime_run_limits", kind: "read" as const, input,
      output: Type.Object({ runsPerPersonPerHour: Type.Integer(), runsPerAgentPerHour: Type.Integer() }),
      handler: async (context: { userId: string }, value: { workspaceId: string }) => {
        await requireWorkspaceRole(db, context.userId, value.workspaceId, "read");
        const [workspace] = await db.select({ runsPerPersonPerHour: workspaces.runtimeRunsPerPersonPerHour, runsPerAgentPerHour: workspaces.runtimeRunsPerAgentPerHour }).from(workspaces).where(eq(workspaces.id, value.workspaceId));
        if (!workspace) throw new ActionError("Workspace not found", 404);
        return workspace;
      },
    },
    setRuntimeRunLimits: {
      name: "set_runtime_run_limits", kind: "write" as const,
      input: Type.Object({ workspaceId: Type.String({ format: "uuid" }), runsPerPersonPerHour: Type.Integer({ minimum: 1, maximum: 10_000 }), runsPerAgentPerHour: Type.Integer({ minimum: 1, maximum: 10_000 }) }),
      output: Type.Object({ runsPerPersonPerHour: Type.Integer(), runsPerAgentPerHour: Type.Integer() }),
      handler: async (context: { userId: string }, value: { workspaceId: string; runsPerPersonPerHour: number; runsPerAgentPerHour: number }) => {
        await requireWorkspaceRole(db, context.userId, value.workspaceId, "admin");
        const [workspace] = await db.update(workspaces).set({ runtimeRunsPerPersonPerHour: value.runsPerPersonPerHour, runtimeRunsPerAgentPerHour: value.runsPerAgentPerHour }).where(eq(workspaces.id, value.workspaceId)).returning({ runsPerPersonPerHour: workspaces.runtimeRunsPerPersonPerHour, runsPerAgentPerHour: workspaces.runtimeRunsPerAgentPerHour });
        if (!workspace) throw new ActionError("Workspace not found", 404);
        return workspace;
      },
    },
  };
}
