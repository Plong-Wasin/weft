import { Type } from "@sinclair/typebox";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Database } from "@weft/db";
import { agentProjects, agents, projects, users, workspaceMembers } from "@weft/db";
import { agentLimitCeilings, agentLimitDefaults, syncAgentProjects } from "./agent-access";
import { cancelQueuedRuns } from "./runs";
import { ActionError, requireWorkspaceRole } from "./members";


type AgentRow = typeof agents.$inferSelect;
const uuid = () => Type.String({ format: "uuid" });
const limit = (ceiling: number) => Type.Integer({ minimum: 1, maximum: ceiling });
const agentOutput = Type.Object({
  id: Type.String(), userId: Type.String(), workspaceId: Type.String(), name: Type.String(), instructions: Type.String(), model: Type.String(), enabled: Type.Boolean(),
  allProjects: Type.Boolean(), projectIds: Type.Array(Type.String()),
  maxToolCalls: Type.Integer(), maxTokens: Type.Integer(), timeoutSeconds: Type.Integer(), monthlyTokenBudget: Type.Union([Type.Integer(), Type.Null()]),
  createdAt: Type.String(),
});
type AgentOutput = {
  id: string; userId: string; workspaceId: string; name: string; instructions: string; model: string; enabled: boolean; allProjects: boolean; projectIds: string[];
  maxToolCalls: number; maxTokens: number; timeoutSeconds: number; monthlyTokenBudget: number | null; createdAt: string;
};
type Limits = { maxToolCalls?: number; maxTokens?: number; timeoutSeconds?: number; monthlyTokenBudget?: number | null };
type Context = { userId: string };

const limitFields = {
  maxToolCalls: Type.Optional(limit(agentLimitCeilings.maxToolCalls)), maxTokens: Type.Optional(limit(agentLimitCeilings.maxTokens)),
  timeoutSeconds: Type.Optional(limit(agentLimitCeilings.timeoutSeconds)), monthlyTokenBudget: Type.Optional(Type.Union([Type.Integer({ minimum: 1 }), Type.Null()])),
};
const textFields = { name: Type.String({ minLength: 1, maxLength: 100 }), instructions: Type.String({ maxLength: 20000 }), model: Type.String({ minLength: 1, maxLength: 200 }) };

/** Agent administration: only workspace Admins configure Agents (ADR 0007). The Agent is a bot user, so assignee and mention code keeps working. */
export function createAgentActions(db: Database) {
  const tx = (transaction: unknown) => transaction as Database;

  function assertLimits(input: Limits) {
    for (const key of ["maxToolCalls", "maxTokens", "timeoutSeconds"] as const) {
      const value = input[key];
      if (value !== undefined && (!Number.isInteger(value) || value < 1 || value > agentLimitCeilings[key])) throw new ActionError(`${key} must be between 1 and ${agentLimitCeilings[key]}`, 400);
    }
    if (input.monthlyTokenBudget != null && (!Number.isInteger(input.monthlyTokenBudget) || input.monthlyTokenBudget < 1)) throw new ActionError("monthlyTokenBudget must be positive", 400);
  }

  async function present(database: Database, rows: AgentRow[]): Promise<AgentOutput[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);
    const names = new Map((await database.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, rows.map((row) => row.userId)))).map((row) => [row.id, row.name]));
    const access = await database.select().from(agentProjects).where(inArray(agentProjects.agentId, ids));
    return rows.map((row) => ({
      id: row.id, userId: row.userId, workspaceId: row.workspaceId, name: names.get(row.userId) ?? "", instructions: row.instructions, model: row.model, enabled: row.enabled,
      allProjects: row.allProjects, projectIds: access.filter((entry) => entry.agentId === row.id).map((entry) => entry.projectId).sort(),
      maxToolCalls: row.maxToolCalls, maxTokens: row.maxTokens, timeoutSeconds: row.timeoutSeconds, monthlyTokenBudget: row.monthlyTokenBudget, createdAt: row.createdAt.toISOString(),
    }));
  }

  /** Loads an Agent and requires the caller to be an Admin of its workspace. An unknown id is a 404. */
  async function loadAdminAgent(database: Database, context: Context, agentId: string, lock = false) {
    const query = database.select().from(agents).where(eq(agents.id, agentId));
    const [agent] = await (lock ? query.for("update") : query);
    if (!agent) throw new ActionError("Agent not found", 404);
    await requireWorkspaceRole(db, context.userId, agent.workspaceId, "admin");
    return agent;
  }

  async function presentOne(database: Database, agentId: string) {
    const [row] = await database.select().from(agents).where(eq(agents.id, agentId));
    return (await present(database, [row!]))[0]!;
  }

  return {
    listAgents: {
      name: "list_agents", kind: "read" as const,
      input: Type.Object({ workspaceId: uuid() }), output: Type.Array(agentOutput),
      handler: async (context: Context, input: { workspaceId: string }) => {
        await requireWorkspaceRole(db, context.userId, input.workspaceId, "admin");
        const rows = await db.select().from(agents).where(eq(agents.workspaceId, input.workspaceId)).orderBy(asc(agents.createdAt), asc(agents.id));
        return present(db, rows);
      },
    },
    getAgent: {
      name: "get_agent", kind: "read" as const,
      input: Type.Object({ agentId: uuid() }), output: agentOutput,
      handler: async (context: Context, input: { agentId: string }) => {
        await loadAdminAgent(db, context, input.agentId);
        return presentOne(db, input.agentId);
      },
    },
    createAgent: {
      name: "create_agent", kind: "write" as const,
      input: Type.Object({ workspaceId: uuid(), ...textFields, ...limitFields }), output: agentOutput,
      handler: async (context: Context, input: { workspaceId: string; name: string; instructions?: string; model: string } & Limits) => {
        await requireWorkspaceRole(db, context.userId, input.workspaceId, "admin");
        assertLimits(input);
        return db.transaction(async (transaction) => {
          const database = tx(transaction);
          const id = crypto.randomUUID();
          // The bot user has no account or session, so nobody can sign in as it.
          await database.insert(users).values({ id, name: input.name, email: `agent-${id}@agents.weft.invalid`, isAgent: true });
          await database.insert(workspaceMembers).values({ workspaceId: input.workspaceId, userId: id, role: "Member" });
          const [row] = await database.insert(agents).values({
            workspaceId: input.workspaceId, userId: id, instructions: input.instructions ?? "", model: input.model, createdBy: context.userId,
            maxToolCalls: input.maxToolCalls ?? agentLimitDefaults.maxToolCalls, maxTokens: input.maxTokens ?? agentLimitDefaults.maxTokens,
            timeoutSeconds: input.timeoutSeconds ?? agentLimitDefaults.timeoutSeconds, monthlyTokenBudget: input.monthlyTokenBudget ?? null,
          }).returning();
          return (await present(database, [row!]))[0]!;
        });
      },
    },
    updateAgent: {
      name: "update_agent", kind: "write" as const,
      input: Type.Object({ agentId: uuid(), name: Type.Optional(textFields.name), instructions: Type.Optional(textFields.instructions), model: Type.Optional(textFields.model), ...limitFields }),
      output: agentOutput,
      handler: async (context: Context, input: { agentId: string; name?: string; instructions?: string; model?: string } & Limits) => {
        assertLimits(input);
        return db.transaction(async (transaction) => {
          const database = tx(transaction);
          const agent = await loadAdminAgent(database, context, input.agentId, true);
          await database.update(agents).set({
            instructions: input.instructions ?? agent.instructions, model: input.model ?? agent.model,
            maxToolCalls: input.maxToolCalls ?? agent.maxToolCalls, maxTokens: input.maxTokens ?? agent.maxTokens, timeoutSeconds: input.timeoutSeconds ?? agent.timeoutSeconds,
            monthlyTokenBudget: input.monthlyTokenBudget === undefined ? agent.monthlyTokenBudget : input.monthlyTokenBudget,
          }).where(eq(agents.id, agent.id));
          if (input.name !== undefined) await database.update(users).set({ name: input.name, updatedAt: new Date() }).where(eq(users.id, agent.userId));
          return presentOne(database, agent.id);
        });
      },
    },
    enableAgent: {
      name: "enable_agent", kind: "write" as const,
      input: Type.Object({ agentId: uuid() }), output: agentOutput,
      handler: async (context: Context, input: { agentId: string }) => setEnabled(context, input.agentId, true),
    },
    disableAgent: {
      name: "disable_agent", kind: "write" as const,
      input: Type.Object({ agentId: uuid() }), output: agentOutput,
      handler: async (context: Context, input: { agentId: string }) => setEnabled(context, input.agentId, false),
    },
    deleteAgent: {
      name: "delete_agent", kind: "write" as const,
      input: Type.Object({ agentId: uuid() }), output: Type.Object({ deleted: Type.Boolean() }),
      handler: async (context: Context, input: { agentId: string }) => db.transaction(async (transaction) => {
        const database = tx(transaction);
        const agent = await loadAdminAgent(database, context, input.agentId, true);
        await cancelQueuedRuns(database, agent.id);
        // Deleting the bot user cascades to its workspace and project memberships, assignments and the Agent row.
        await database.delete(users).where(eq(users.id, agent.userId));
        return { deleted: true };
      }),
    },
    setAgentProjectAccess: {
      name: "set_agent_project_access", kind: "write" as const,
      input: Type.Object({ agentId: uuid(), allProjects: Type.Boolean(), projectIds: Type.Array(uuid()) }), output: agentOutput,
      handler: async (context: Context, input: { agentId: string; allProjects: boolean; projectIds: string[] }) => db.transaction(async (transaction) => {
        const database = tx(transaction);
        const agent = await loadAdminAgent(database, context, input.agentId, true);
        const ids = input.allProjects ? [] : [...new Set(input.projectIds)];
        if (ids.length > 0) {
          const found = await database.select({ id: projects.id }).from(projects).where(and(eq(projects.workspaceId, agent.workspaceId), inArray(projects.id, ids)));
          if (found.length !== ids.length) throw new ActionError("Projects must belong to the Agent's workspace", 400);
        }
        await database.update(agents).set({ allProjects: input.allProjects }).where(eq(agents.id, agent.id));
        await database.delete(agentProjects).where(eq(agentProjects.agentId, agent.id));
        if (ids.length > 0) await database.insert(agentProjects).values(ids.map((projectId) => ({ agentId: agent.id, projectId })));
        await syncAgentProjects(database, { ...agent, allProjects: input.allProjects });
        return presentOne(database, agent.id);
      }),
    },
  };

  async function setEnabled(context: Context, agentId: string, enabled: boolean) {
    return db.transaction(async (transaction) => {
      const database = tx(transaction);
      const agent = await loadAdminAgent(database, context, agentId, true);
      await database.update(agents).set({ enabled }).where(eq(agents.id, agent.id));
      if (!enabled) await cancelQueuedRuns(database, agent.id);
      return presentOne(database, agent.id);
    });
  }
}
