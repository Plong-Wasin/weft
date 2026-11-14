import { afterAll, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { agents, apiTokens, createDatabase, daemons, runs, runtimes, users, workspaces, type Database } from "@weft/db";
import { createMemberFactory, withRollback } from "../../db/src/test-helpers";
import { createAgentActions, createProjectActions, createRunActions, createRuntimeDispatchActions, createUsageActions, createWorkItemActions, agentMonthlyUsage } from "../src";
import { createWorkspaceFactory } from "../../db/src/test-helpers";

const { client, db } = createDatabase();
afterAll(async () => client.end());

const today = () => new Date().toISOString().slice(0, 10);

/** A workspace with an Admin, a Member who owns a Daemon Runtime, and a Runtime Agent with an optional monthly token budget. */
async function setup(transaction: Database, monthlyTokenBudget: number | null) {
  const workspace = await createWorkspaceFactory(transaction);
  const admin = await createMemberFactory(transaction, workspace.id, "Admin");
  const member = await createMemberFactory(transaction, workspace.id, "Member");
  await transaction.update(workspaces).set({ allowAutopilot: true }).where(eq(workspaces.id, workspace.id));
  const projects = createProjectActions(transaction);
  const project = await projects.createProject.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Alpha", key: "ALP", visibility: "public" });
  await projects.addProjectMember.handler({ userId: admin.id }, { projectId: project.id, userId: member.id, role: "Member" });
  const agentActions = createAgentActions(transaction);
  const agent = await agentActions.createAgent.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Bot", model: "default", monthlyTokenBudget });
  await agentActions.setAgentProjectAccess.handler({ userId: admin.id }, { agentId: agent.id, allProjects: true, projectIds: [] });
  const [token] = await transaction.insert(apiTokens).values({ userId: member.id, name: "Daemon", tokenHash: crypto.randomUUID(), tokenPrefix: "weft_daemon", daemonOnly: true, expiresAt: new Date(Date.now() + 86_400_000) }).returning();
  const [daemon] = await transaction.insert(daemons).values({ ownerId: member.id, tokenId: token!.id, hostname: "laptop", version: "1.0.0" }).returning();
  const [runtime] = await transaction.insert(runtimes).values({ workspaceId: workspace.id, daemonId: daemon!.id, ownerId: member.id, agentCli: "claude", shared: true, lastSeenAt: new Date() }).returning();
  await transaction.update(agents).set({ runtimeId: runtime!.id, cliModel: null }).where(eq(agents.id, agent.id));
  const work = createWorkItemActions(transaction);
  const assign = async (title: string) => {
    const item = await work.createWorkItem.handler({ userId: member.id }, { projectId: project.id, title });
    await work.updateWorkItem.handler({ userId: member.id }, { workItemId: item.id, assigneeIds: [agent.userId] });
    const [run] = await transaction.select().from(runs).where(eq(runs.workItemId, item.id));
    return run!;
  };
  const dispatch = createRuntimeDispatchActions(transaction);
  /** Claims the queued Run, starts it and lets the Daemon finish it with what the CLI reported. */
  const execute = async (runId: string, outcome: { usage?: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheCreationTokens?: number; reportedCostUsd?: number | null } | null; model?: string | null; status?: "completed" | "failed"; failureReason?: string }) => {
    await dispatch.claimRuns({ userId: member.id, daemonId: daemon!.id }, 5);
    await dispatch.startRun(runId, runtime!.id);
    await dispatch.finishRun(runId, { status: "completed", finalOutput: "Done.", ...outcome });
  };
  const listed = async (workItemId: string) => createRunActions(transaction).listRuns.handler({ userId: member.id }, { workItemId });
  return { workspace, admin, member, agent, runtime: runtime!, daemon: daemon!, assign, execute, listed, transaction, usage: createUsageActions(transaction, () => new Date()) };
}

const reload = async (transaction: Database, runId: string) => (await transaction.select().from(runs).where(eq(runs.id, runId)))[0]!;

test.concurrent("a Runtime Run keeps the CLI's usage, model and elapsed time, and is priced from the admin's table", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction, null);
    await s.usage.setModelPrice.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id, model: "claude-sonnet-5-5", inputUsdPerMillion: 3, outputUsdPerMillion: 15 });
    const run = await s.assign("Priced");
    await s.execute(run.id, { usage: { inputTokens: 1000, outputTokens: 500 }, model: "claude-sonnet-5-5" });
    const [shown] = await s.listed((await reload(transaction, run.id)).workItemId!);
    expect(shown).toMatchObject({ status: "completed", usageReported: true, inputTokens: 1000, outputTokens: 500, model: "claude-sonnet-5-5", estimatedCostUsd: 0.0105 });
    expect(shown!.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(shown!.failureMessage).toBeNull();
  });
});

test("simultaneous finish and cancel acknowledgement report Run usage once and keep terminal status", async () => {
  // Committed rows on the shared pool: the two calls open separate connections and really race on the row lock.
  const s = await setup(db, null);
  try {
    const run = await s.assign("Concurrent report");
    await s.execute(run.id, { usage: null });
    // Return the finished row to a state where both terminal acknowledgements may contribute usage.
    await db.update(runs).set({ status: "failed", failureReason: "timeout", usageReported: false, inputTokens: 0, outputTokens: 0, model: null }).where(eq(runs.id, run.id));
    const dispatch = createRuntimeDispatchActions(db);
    await Promise.all([
      dispatch.finishRun(run.id, { status: "completed", finalOutput: "late", usage: { inputTokens: 17, outputTokens: 5 }, model: "finish-model" }),
      dispatch.acknowledgeCancel(run.id, { inputTokens: 17, outputTokens: 5 }, "cancel-model"),
    ]);
    // Usage is 17/5, not 34/10: the second caller saw usageReported after waiting for the first's lock.
    expect(await reload(db, run.id)).toMatchObject({ status: "failed", failureReason: "timeout", usageReported: true, inputTokens: 17, outputTokens: 5 });
  } finally {
    await db.delete(workspaces).where(eq(workspaces.id, s.workspace.id));
    await db.delete(users).where(inArray(users.id, [s.admin.id, s.member.id, s.agent.userId]));
  }
});

test.concurrent("a Runtime Run whose CLI printed no usage shows unknown tokens and cost, not zero", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction, null);
    await s.usage.setModelPrice.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id, model: "claude-sonnet-5-5", inputUsdPerMillion: 3, outputUsdPerMillion: 15 });
    const run = await s.assign("Silent");
    await s.execute(run.id, { usage: null });
    const [shown] = await s.listed((await reload(transaction, run.id)).workItemId!);
    expect(shown).toMatchObject({ status: "completed", usageReported: false, model: null, estimatedCostUsd: null });
    expect(shown!.elapsedMs).not.toBeNull();
  });
});

test.concurrent("a model without a price stays unknown until an Admin sets its price", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction, null);
    const run = await s.assign("Unpriced");
    await s.execute(run.id, { usage: { inputTokens: 200, outputTokens: 100 }, model: "new-model" });
    const workItemId = (await reload(transaction, run.id)).workItemId!;
    expect((await s.listed(workItemId))[0]).toMatchObject({ usageReported: true, estimatedCostUsd: null });
    await s.usage.setModelPrice.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id, model: "new-model", inputUsdPerMillion: 2, outputUsdPerMillion: 10 });
    expect((await s.listed(workItemId))[0]).toMatchObject({ estimatedCostUsd: 0.0014 });
  });
});

test.concurrent("Runtime Runs count against the Agent's monthly budget, and an over-budget Run is refused with a message", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction, 1000);
    const first = await s.assign("First");
    await s.execute(first.id, { usage: { inputTokens: 900, outputTokens: 200 }, model: "claude-sonnet-5-5" });
    const second = await s.assign("Second");
    expect(await reload(transaction, second.id)).toMatchObject({ status: "skipped", failureReason: "budget_exceeded" });
    const [refused] = await s.listed((await reload(transaction, second.id)).workItemId!);
    expect(refused).toMatchObject({ status: "skipped" });
    expect(refused!.failureMessage).toContain("monthly token budget is used up");
  });
});

test.concurrent("a Run queued before the budget ran out is refused when a Daemon claims it", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction, 1000);
    const earlier = await s.assign("Earlier");
    const queued = await s.assign("Queued");
    expect((await reload(transaction, queued.id)).status).toBe("queued");
    await transaction.update(runs).set({ status: "completed", usageReported: true, inputTokens: 1100, outputTokens: 0 }).where(eq(runs.id, earlier.id));
    expect(await createRuntimeDispatchActions(transaction).claimRuns({ userId: s.member.id, daemonId: s.daemon.id }, 5)).toEqual([]);
    expect(await reload(transaction, queued.id)).toMatchObject({ status: "skipped", failureReason: "budget_exceeded" });
  });
});

test.concurrent("the usage summary groups by day, Agent and person for Admins only, and checks its date range", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction, null);
    await s.usage.setModelPrice.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id, model: "claude-sonnet-5-5", inputUsdPerMillion: 3, outputUsdPerMillion: 15 });
    const reported = await s.assign("Reported");
    await s.execute(reported.id, { usage: { inputTokens: 1000, outputTokens: 500 }, model: "claude-sonnet-5-5" });
    const silent = await s.assign("Silent");
    await s.execute(silent.id, { usage: null });
    const range = { workspaceId: s.workspace.id, from: today(), to: today() };
    const summary = await s.usage.getUsageSummary.handler({ userId: s.admin.id }, range);
    expect(summary.rows).toHaveLength(1);
    expect(summary.rows[0]).toMatchObject({ day: today(), agentId: s.agent.id, agentName: "Bot", personId: s.member.id, runs: 2, unknownUsageRuns: 1, inputTokens: 1000, outputTokens: 500, estimatedCostUsd: 0.0105 });
    expect(summary.totals).toMatchObject({ runs: 2, unknownUsageRuns: 1, unknownCostRuns: 1, inputTokens: 1000, outputTokens: 500, estimatedCostUsd: 0.0105 });
    await expect(s.usage.getUsageSummary.handler({ userId: s.member.id }, range)).rejects.toMatchObject({ status: 403 });
    await expect(s.usage.getUsageSummary.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id, from: "2026-02-10", to: "2026-02-01" })).rejects.toMatchObject({ status: 400 });
    expect(await s.usage.getUsageSummary.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id, from: "2001-01-01", to: "2001-01-02" })).toMatchObject({ rows: [], totals: { runs: 0, inputTokens: null } });
  });
});

test.concurrent("the price table is Admin-only and one row per model: a second save replaces the first", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction, null);
    const first = await s.usage.setModelPrice.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id, model: "m1", inputUsdPerMillion: 1, outputUsdPerMillion: 2 });
    const replaced = await s.usage.setModelPrice.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id, model: "m1", inputUsdPerMillion: 4, outputUsdPerMillion: 8 });
    expect(replaced).toMatchObject({ id: first.id, model: "m1", inputUsdPerMillion: 4, outputUsdPerMillion: 8 });
    expect(await s.usage.listModelPrices.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id })).toHaveLength(1);
    await expect(s.usage.setModelPrice.handler({ userId: s.member.id }, { workspaceId: s.workspace.id, model: "m2", inputUsdPerMillion: 1, outputUsdPerMillion: 1 })).rejects.toMatchObject({ status: 403 });
    await expect(s.usage.listModelPrices.handler({ userId: s.member.id }, { workspaceId: s.workspace.id })).rejects.toMatchObject({ status: 403 });
    await s.usage.deleteModelPrice.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id, priceId: first.id });
    expect(await s.usage.listModelPrices.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id })).toEqual([]);
  });
});

test.concurrent("cache reads are priced at the cached-input price (the input price when none is set), cache creation at the input price", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction, null);
    await s.usage.setModelPrice.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id, model: "m-cached", inputUsdPerMillion: 3, outputUsdPerMillion: 15, cachedInputUsdPerMillion: 0.3 });
    await s.usage.setModelPrice.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id, model: "m-plain", inputUsdPerMillion: 3, outputUsdPerMillion: 15 });
    const usage = { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 2_000_000, cacheCreationTokens: 500_000 };
    const cached = await s.assign("Cached");
    await s.execute(cached.id, { usage, model: "m-cached" });
    const plain = await s.assign("Plain");
    await s.execute(plain.id, { usage, model: "m-plain" });
    const shown = async (id: string) => (await s.listed((await reload(transaction, id)).workItemId!))[0]!;
    // 1.5M at $3 + 2M at $0.3 + 0.1M at $15 = 4.5 + 0.6 + 1.5
    expect(await shown(cached.id)).toMatchObject({ cacheReadTokens: 2_000_000, cacheCreationTokens: 500_000, estimatedCostUsd: 6.6, costReported: false });
    // 3.5M at $3 + 1.5
    expect(await shown(plain.id)).toMatchObject({ estimatedCostUsd: 12 });
    expect((await s.usage.listModelPrices.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id })).map((price) => [price.model, price.cachedInputUsdPerMillion])).toEqual([["m-cached", 0.3], ["m-plain", null]]);
  });
});

test.concurrent("the cost the CLI reported wins over the estimate, and is labelled as reported, even with no price", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction, null);
    const run = await s.assign("Reported cost");
    await s.execute(run.id, { usage: { inputTokens: 2, outputTokens: 4, cacheReadTokens: 7368, cacheCreationTokens: 18845, reportedCostUsd: 0.0761608 }, model: "claude-sonnet-5-5" });
    expect((await s.listed((await reload(transaction, run.id)).workItemId!))[0]).toMatchObject({ estimatedCostUsd: 0.076161, costReported: true });
    const summary = await s.usage.getUsageSummary.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id, from: today(), to: today() });
    expect(summary.rows[0]).toMatchObject({ reportedCostRuns: 1, unknownCostRuns: 0, estimatedCostUsd: 0.076161, cacheReadTokens: 7368, cacheCreationTokens: 18845 });
  });
});

test.concurrent("token sums above 2^31 do not overflow in the budget or the usage summary", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction, null);
    const a = await s.assign("Big A");
    const b = await s.assign("Big B");
    const big = { status: "completed", usageReported: true, inputTokens: 2_000_000_000, outputTokens: 1_000_000_000, cacheReadTokens: 1_000_000_000, cacheCreationTokens: 5 };
    await transaction.update(runs).set(big).where(eq(runs.id, a.id));
    await transaction.update(runs).set(big).where(eq(runs.id, b.id));
    expect(await agentMonthlyUsage(transaction, s.agent.id)).toBe(2 * (4_000_000_005));
    const summary = await s.usage.getUsageSummary.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id, from: today(), to: today() });
    expect(summary.totals).toMatchObject({ inputTokens: 4_000_000_000, outputTokens: 2_000_000_000, cacheReadTokens: 2_000_000_000, cacheCreationTokens: 10 });
  });
});

test.concurrent("the summary lists the models that have Runs with reported usage but no price", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction, null);
    await s.usage.setModelPrice.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id, model: "priced", inputUsdPerMillion: 1, outputUsdPerMillion: 1 });
    for (const [title, model] of [["A", "priced"], ["B", "gpt-new"], ["C", "gpt-new"], ["D", "claude-new"]] as const) {
      const run = await s.assign(title);
      await s.execute(run.id, { usage: { inputTokens: 10, outputTokens: 5 }, model });
    }
    const summary = await s.usage.getUsageSummary.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id, from: today(), to: today() });
    expect(summary.unpricedModels).toEqual([{ model: "claude-new", runs: 1 }, { model: "gpt-new", runs: 2 }]);
  });
});
