import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { agents, createDatabase, outboundWebhookDeliveries, runs, type Database } from "@weft/db";
import { createAgentActions, createOutboundWebhookActions, createProjectActions, createWorkItemActions, executeRun } from "../src";
import { createMemberFactory, createWorkspaceFactory, withRollback } from "../../db/src/test-helpers";

const flag = "WEFT_OUTBOUND_WEBHOOKS_ENABLED";
let previousFlag: string | undefined;
const { client, db } = createDatabase();
beforeAll(() => { previousFlag = Bun.env[flag]; Bun.env[flag] = "true"; });
afterAll(async () => {
  if (previousFlag === undefined) delete Bun.env[flag]; else Bun.env[flag] = previousFlag;
  await client.end();
});

async function setup(tx: Database) {
  const workspace = await createWorkspaceFactory(tx);
  const admin = await createMemberFactory(tx, workspace.id, "Admin");
  const project = await createProjectActions(tx).createProject.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Executor", key: "EXE", visibility: "public" });
  const agent = await createAgentActions(tx).createAgent.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Runner", model: "default" });
  await createAgentActions(tx).setAgentProjectAccess.handler({ userId: admin.id }, { agentId: agent.id, allProjects: true, projectIds: [] });
  const [run] = await tx.insert(runs).values({ workspaceId: workspace.id, projectId: project.id, agentId: agent.id, originatorId: admin.id, status: "running", startedAt: new Date() }).returning();
  return { workspace, admin, project, agent, run: run! };
}

const model = { async step() { return { text: "Finished", toolCalls: [], usage: { inputTokens: 2, outputTokens: 1 } }; } };

test("server run finish rolls back with a failed run.finished insert, retries once, and leaves the event table empty when disabled", async () => {
  await withRollback(db, async (tx) => {
    const s = await setup(tx);
    const hooks = createOutboundWebhookActions(tx);
    const hook = await hooks.createOutboundWebhook.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id, name: "Run finish", url: "https://93.184.216.34/hook", events: ["run.finished"] });
    await tx.execute(sql`CREATE FUNCTION fail_server_run_finished() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type = 'run.finished' THEN RAISE EXCEPTION 'injected server run.finished failure'; END IF; RETURN NEW; END; $$`);
    await tx.execute(sql`CREATE TRIGGER fail_server_run_finished BEFORE INSERT ON outbound_webhook_deliveries FOR EACH ROW EXECUTE FUNCTION fail_server_run_finished()`);
    let failedToEmit = false;
    try { await executeRun(tx, s.run.id, { model }); } catch { failedToEmit = true; }
    expect(failedToEmit).toBe(true);
    expect((await tx.select().from(runs).where(eq(runs.id, s.run.id)))[0]?.status).toBe("running");
    expect((await tx.select().from(runs).where(eq(runs.id, s.run.id)))[0]).toMatchObject({ status: "running", finishedAt: null });
    expect(await tx.select().from(outboundWebhookDeliveries).where(eq(outboundWebhookDeliveries.webhookId, hook.id))).toHaveLength(0);
    await tx.execute(sql`DROP TRIGGER fail_server_run_finished ON outbound_webhook_deliveries`);
    await tx.execute(sql`DROP FUNCTION fail_server_run_finished()`);
    await executeRun(tx, s.run.id, { model });
    expect((await tx.select().from(runs).where(eq(runs.id, s.run.id)))[0]?.status).toBe("completed");
    expect(await tx.select().from(outboundWebhookDeliveries).where(eq(outboundWebhookDeliveries.webhookId, hook.id))).toHaveLength(1);

    const withoutHook = await setup(tx);
    Bun.env[flag] = "false";
    await executeRun(tx, withoutHook.run.id, { model });
    expect(await tx.select().from(outboundWebhookDeliveries).where(eq(outboundWebhookDeliveries.workspaceId, withoutHook.workspace.id))).toHaveLength(0);
    Bun.env[flag] = "true";
  });
});
