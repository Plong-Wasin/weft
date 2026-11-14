import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { agents, createDatabase, jobs, outboundWebhookDeliveries, outboundWebhooks, runs } from "@weft/db";
import { createMemberFactory, createWorkspaceFactory, withRollback } from "../../db/src/test-helpers";
import { createAgentActions, createApiTokenActions, createProjectActions, createRunActions, createRuntimeActions, createRuntimeDispatchActions, createWorkItemActions } from "../src";
import { outboundJobType } from "../src/outbound-webhooks";
import { sealSecret } from "../src/integration-secrets";

const flag = "WEFT_OUTBOUND_WEBHOOKS_ENABLED";
let previousFlag: string | undefined;
const { client, db } = createDatabase();
beforeAll(() => { previousFlag = Bun.env[flag]; Bun.env[flag] = "false"; });
afterAll(async () => {
  if (previousFlag === undefined) delete Bun.env[flag]; else Bun.env[flag] = previousFlag;
  await client.end();
});

test("with webhooks disabled, finish, cancel, acknowledgement and daemon stop write no event or delivery rows or jobs", async () => withRollback(db, async (tx) => {
  const workspace = await createWorkspaceFactory(tx);
  const admin = await createMemberFactory(tx, workspace.id, "Admin");
  const member = await createMemberFactory(tx, workspace.id, "Member");
  const projectActions = createProjectActions(tx);
  const project = await projectActions.createProject.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Disabled webhooks", key: "OFF", visibility: "public" });
  await projectActions.addProjectMember.handler({ userId: admin.id }, { projectId: project.id, userId: member.id, role: "Member" });
  const [webhook] = await tx.insert(outboundWebhooks).values({
    workspaceId: workspace.id, name: "Subscribed", url: "https://93.184.216.34/hook", secretSealed: sealSecret("test-secret"), events: ["run.finished"], createdBy: admin.id,
  }).returning();
  const token = await createApiTokenActions(tx).createApiToken.handler({ userId: member.id }, { name: "daemon" });
  const registered = await createRuntimeActions(tx).registerDaemon.handler({ userId: member.id, apiTokenId: token.id }, { hostname: "disabled-test", version: "1", agentClis: ["codex"] });
  const runtime = registered.runtimes[0]!;
  const agent = await createAgentActions(tx).createAgent.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Runtime agent", model: "default", monthlyTokenBudget: null });
  await createAgentActions(tx).setAgentProjectAccess.handler({ userId: admin.id }, { agentId: agent.id, allProjects: true, projectIds: [] });
  await tx.update(agents).set({ runtimeId: runtime.id }).where(eq(agents.id, agent.id));
  const workItems = createWorkItemActions(tx);
  const makeRun = async (title: string) => {
    const item = await workItems.createWorkItem.handler({ userId: member.id }, { projectId: project.id, title });
    await workItems.updateWorkItem.handler({ userId: member.id }, { workItemId: item.id, assigneeIds: [agent.userId] });
    const [run] = await tx.select().from(runs).where(eq(runs.workItemId, item.id));
    return run!;
  };
  const dispatch = createRuntimeDispatchActions(tx);
  const finish = await makeRun("Finish");
  await tx.update(runs).set({ status: "running", runtimeId: runtime.id }).where(eq(runs.id, finish.id));
  await dispatch.finishRun(finish.id, { status: "completed", finalOutput: "Done" });

  const cancel = await makeRun("Cancel through Runs");
  await tx.update(runs).set({ status: "dispatched", runtimeId: runtime.id }).where(eq(runs.id, cancel.id));
  await createRunActions(tx).cancelRun.handler({ userId: member.id }, { runId: cancel.id });

  const acknowledged = await makeRun("Cancel acknowledgement");
  await tx.update(runs).set({ status: "running", runtimeId: runtime.id }).where(eq(runs.id, acknowledged.id));
  await createRunActions(tx).cancelRun.handler({ userId: member.id }, { runId: acknowledged.id });
  await dispatch.acknowledgeCancel(acknowledged.id);

  const stopDispatched = await makeRun("Daemon stops dispatched");
  const stopRunning = await makeRun("Daemon stops running");
  await tx.update(runs).set({ status: "dispatched", runtimeId: runtime.id }).where(eq(runs.id, stopDispatched.id));
  await tx.update(runs).set({ status: "running", runtimeId: runtime.id }).where(eq(runs.id, stopRunning.id));
  await dispatch.stopDaemon(registered.daemonId, member.id);

  const endingRuns = await tx.select({ id: runs.id, status: runs.status }).from(runs).where(eq(runs.workspaceId, workspace.id));
  expect(endingRuns.find((run) => run.id === finish.id)?.status).toBe("completed");
  expect(endingRuns.find((run) => run.id === cancel.id)?.status).toBe("cancelled");
  expect(endingRuns.find((run) => run.id === acknowledged.id)?.status).toBe("cancelled");
  expect(endingRuns.find((run) => run.id === stopDispatched.id)?.status).toBe("cancelled");
  expect(endingRuns.find((run) => run.id === stopRunning.id)?.status).toBe("stopping");
  expect(await tx.select().from(outboundWebhookDeliveries).where(eq(outboundWebhookDeliveries.webhookId, webhook!.id))).toHaveLength(0);
  expect(await tx.select().from(jobs).where(eq(jobs.type, outboundJobType))).toHaveLength(0);
}));
