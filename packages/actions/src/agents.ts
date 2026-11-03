import { Type } from "@sinclair/typebox";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Database } from "@weft/db";
import { agentProjects, agentSkills, agents, daemons, projects, runs, runtimes, skills, users, workspaceMembers, workspaces } from "@weft/db";
import { agentMonthlyUsage } from "./agent-budget";
import { agentLimitCeilings, agentLimitDefaults, syncAgentProjects } from "./agent-access";
import { enqueueJob } from "./jobs";
import { cancelQueuedRuns } from "./runs";
import { ActionError, requireWorkspaceRole } from "./members";


type AgentRow = typeof agents.$inferSelect;
const uuid = () => Type.String({ format: "uuid" });
const limit = (ceiling: number) => Type.Integer({ minimum: 1, maximum: ceiling });
const agentOutput = Type.Object({
  id: Type.String(), userId: Type.String(), workspaceId: Type.String(), name: Type.String(), instructions: Type.String(), model: Type.String(), enabled: Type.Boolean(),
  allProjects: Type.Boolean(), projectIds: Type.Array(Type.String()),
  autopilot: Type.Boolean(),
  skills: Type.Array(Type.Object({ id: Type.String(), name: Type.String(), description: Type.String() })),
  maxToolCalls: Type.Integer(), maxTokens: Type.Integer(), timeoutSeconds: Type.Integer(), monthlyTokenBudget: Type.Union([Type.Integer(), Type.Null()]), monthlyTokensUsed: Type.Integer(),
  runtimeId: Type.Union([Type.String(), Type.Null()]), runtimeName: Type.Union([Type.String(), Type.Null()]), runtimeShared: Type.Boolean(), runtimeOnline: Type.Boolean(), cliModel: Type.Union([Type.String(), Type.Null()]), maxConcurrentRuns: Type.Integer(),
  createdAt: Type.String(),
});
type AgentOutput = {
  id: string; userId: string; workspaceId: string; name: string; instructions: string; model: string; enabled: boolean; allProjects: boolean; projectIds: string[]; autopilot: boolean;
  skills: Array<{ id: string; name: string; description: string }>;
  maxToolCalls: number; maxTokens: number; timeoutSeconds: number; monthlyTokenBudget: number | null; monthlyTokensUsed: number; runtimeId: string | null; runtimeName: string | null; runtimeShared: boolean; runtimeOnline: boolean; cliModel: string | null; maxConcurrentRuns: number; createdAt: string;
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
    const attached = await database.select({ agentId: agentSkills.agentId, id: skills.id, name: skills.name, description: skills.description })
      .from(agentSkills).innerJoin(skills, eq(agentSkills.skillId, skills.id)).where(inArray(agentSkills.agentId, ids)).orderBy(asc(skills.name), asc(skills.id));
    const usage = new Map(await Promise.all(rows.map(async (row) => [row.id, await agentMonthlyUsage(database, row.id)] as const)));
    const runtimeIds = rows.flatMap((row) => row.runtimeId ? [row.runtimeId] : []);
    const runtimeRows = runtimeIds.length ? await database.select({ id: runtimes.id, workspaceId: runtimes.workspaceId, shared: runtimes.shared, cli: runtimes.agentCli, hostname: daemons.hostname, lastSeenAt: runtimes.lastSeenAt })
      .from(runtimes).innerJoin(daemons, eq(daemons.id, runtimes.daemonId)).where(inArray(runtimes.id, runtimeIds)) : [];
    const runtimeById = new Map(runtimeRows.map((runtime) => [runtime.id, runtime]));
    return rows.map((row) => ({
      id: row.id, userId: row.userId, workspaceId: row.workspaceId, name: names.get(row.userId) ?? "", instructions: row.instructions, model: row.model, enabled: row.enabled,
      autopilot: row.runtimeId !== null || row.autopilot,
      allProjects: row.allProjects, projectIds: access.filter((entry) => entry.agentId === row.id).map((entry) => entry.projectId).sort(),
      skills: attached.filter((entry) => entry.agentId === row.id).map(({ id, name, description }) => ({ id, name, description })),
      maxToolCalls: row.maxToolCalls, maxTokens: row.maxTokens, timeoutSeconds: row.timeoutSeconds, monthlyTokenBudget: row.monthlyTokenBudget, monthlyTokensUsed: usage.get(row.id) ?? 0, createdAt: row.createdAt.toISOString(),
      runtimeId: row.runtimeId, runtimeName: row.runtimeId && runtimeById.get(row.runtimeId)?.shared ? `${runtimeById.get(row.runtimeId)!.hostname} · ${runtimeById.get(row.runtimeId)!.cli}` : null,
      runtimeShared: row.runtimeId ? runtimeById.get(row.runtimeId)?.shared ?? false : false,
      runtimeOnline: row.runtimeId ? (runtimeById.get(row.runtimeId)?.lastSeenAt.getTime() ?? 0) > Date.now() - 150_000 : false,
      cliModel: row.cliModel, maxConcurrentRuns: row.maxConcurrentRuns,
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
      input: Type.Object({ workspaceId: uuid(), ...textFields, autopilot: Type.Optional(Type.Boolean()), runtimeId: Type.Optional(Type.Union([uuid(), Type.Null()])), cliModel: Type.Optional(Type.Union([Type.String({ maxLength: 200 }), Type.Null()])), maxConcurrentRuns: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })), ...limitFields }), output: agentOutput,
      handler: async (context: Context, input: { workspaceId: string; name: string; instructions?: string; model: string; autopilot?: boolean; runtimeId?: string | null; cliModel?: string | null; maxConcurrentRuns?: number } & Limits) => {
        await requireWorkspaceRole(db, context.userId, input.workspaceId, "admin");
        if (input.autopilot === true && !input.runtimeId) {
          const [workspace] = await db.select({ allowAutopilot: workspaces.allowAutopilot }).from(workspaces).where(eq(workspaces.id, input.workspaceId));
          if (!workspace?.allowAutopilot) throw new ActionError("Autopilot is disabled for this workspace", 400);
        }
        if (input.runtimeId) {
          const [runtime] = await db.select({ id: runtimes.id }).from(runtimes).where(and(eq(runtimes.id, input.runtimeId), eq(runtimes.workspaceId, input.workspaceId), eq(runtimes.shared, true)));
          if (!runtime) throw new ActionError("Runtime must be shared with this workspace", 400);
        }
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
            autopilot: input.runtimeId ? true : input.autopilot ?? false,
            runtimeId: input.runtimeId ?? null, cliModel: input.cliModel ?? null, maxConcurrentRuns: input.maxConcurrentRuns ?? 6,
          }).returning();
          return (await present(database, [row!]))[0]!;
        });
      },
    },
    updateAgent: {
      name: "update_agent", kind: "write" as const,
      input: Type.Object({ agentId: uuid(), name: Type.Optional(textFields.name), instructions: Type.Optional(textFields.instructions), model: Type.Optional(textFields.model), autopilot: Type.Optional(Type.Boolean()), runtimeId: Type.Optional(Type.Union([uuid(), Type.Null()])), cliModel: Type.Optional(Type.Union([Type.String({ maxLength: 200 }), Type.Null()])), maxConcurrentRuns: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })), ...limitFields }),
      output: agentOutput,
      handler: async (context: Context, input: { agentId: string; name?: string; instructions?: string; model?: string; autopilot?: boolean; runtimeId?: string | null; cliModel?: string | null; maxConcurrentRuns?: number } & Limits) => {
        assertLimits(input);
        return db.transaction(async (transaction) => {
          const database = tx(transaction);
          const agent = await loadAdminAgent(database, context, input.agentId, true);
          const runtimeId = input.runtimeId === undefined ? agent.runtimeId : input.runtimeId;
          if (input.autopilot === true && !runtimeId) {
            const [workspace] = await database.select({ allowAutopilot: workspaces.allowAutopilot }).from(workspaces).where(eq(workspaces.id, agent.workspaceId));
            if (!workspace?.allowAutopilot) throw new ActionError("Autopilot is disabled for this workspace", 400);
          }
          if (runtimeId && runtimeId !== agent.runtimeId) {
            const [runtime] = await database.select({ id: runtimes.id }).from(runtimes).where(and(eq(runtimes.id, runtimeId), eq(runtimes.workspaceId, agent.workspaceId), eq(runtimes.shared, true)));
            if (!runtime) throw new ActionError("Runtime must be shared with this workspace", 400);
          }
          await database.update(agents).set({
            instructions: input.instructions ?? agent.instructions, model: input.model ?? agent.model,
            autopilot: runtimeId !== null || (input.autopilot ?? (agent.runtimeId ? false : agent.autopilot)),
            maxToolCalls: input.maxToolCalls ?? agent.maxToolCalls, maxTokens: input.maxTokens ?? agent.maxTokens, timeoutSeconds: input.timeoutSeconds ?? agent.timeoutSeconds,
            monthlyTokenBudget: input.monthlyTokenBudget === undefined ? agent.monthlyTokenBudget : input.monthlyTokenBudget,
            runtimeId, cliModel: input.cliModel === undefined ? agent.cliModel : input.cliModel, maxConcurrentRuns: input.maxConcurrentRuns ?? agent.maxConcurrentRuns,
          }).where(eq(agents.id, agent.id));
          if (agent.runtimeId && runtimeId === null) {
            // Runs queued for the Runtime would otherwise wait forever: hand them to the server worker.
            const stranded = await database.select({ id: runs.id }).from(runs).where(and(eq(runs.agentId, agent.id), eq(runs.status, "queued")));
            for (const run of stranded) await enqueueJob(database, { type: "agent_run", payload: { runId: run.id }, dedupeKey: `agent_run:${run.id}:unbound` });
          }
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
    setAgentSkills: {
      name: "set_agent_skills", kind: "write" as const,
      input: Type.Object({ agentId: uuid(), skillIds: Type.Array(uuid()) }), output: agentOutput,
      handler: async (context: Context, input: { agentId: string; skillIds: string[] }) => db.transaction(async (transaction) => {
        const database = tx(transaction);
        const agent = await loadAdminAgent(database, context, input.agentId, true);
        const ids = [...new Set(input.skillIds)];
        if (ids.length) {
          // One message for a missing, foreign or Personal id, so another member's Personal skill id is not confirmed to exist.
          const found = await database.select({ id: skills.id }).from(skills)
            .where(and(eq(skills.workspaceId, agent.workspaceId), eq(skills.scope, "workspace"), inArray(skills.id, ids))).for("share");
          if (found.length !== ids.length) throw new ActionError("Only existing Workspace Skills of this workspace can be attached to an Agent", 400);
        }
        await database.delete(agentSkills).where(eq(agentSkills.agentId, agent.id));
        if (ids.length) await database.insert(agentSkills).values(ids.map((skillId) => ({ agentId: agent.id, skillId })));
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
