import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createDatabase, jobs, outboundWebhookDeliveries, outboundWebhooks } from "@weft/db";
import { createMemberFactory, createWorkspaceFactory, withRollback } from "../../db/src/test-helpers";
import { createActionList, createJobHandlers, createProjectActions, createWorkItemActions, emitOutboundEvent, outboundJobType, outboundWebhookActionNames, scheduleCleanupJobs } from "../src";

// This file runs with WEFT_OUTBOUND_WEBHOOKS_ENABLED unset, the default: nothing about outbound webhooks may happen.
const { client, db } = createDatabase();
afterAll(async () => client.end());

test.concurrent("with the flag off the webhook Actions are not in the Action list, so REST, the CLI, MCP and the AI cannot reach them", () => {
  const names = createActionList({} as never).map((action) => action.name);
  for (const name of outboundWebhookActionNames) expect(names).not.toContain(name);
  expect(names).toContain("create_work_item");
});

test.concurrent("with the flag off no delivery job is handled", () => {
  expect(Object.keys(createJobHandlers())).not.toContain(outboundJobType);
});

test.concurrent("with the flag off an event is not built and nothing is written, even when work is saved", async () => withRollback(db, async (tx) => {
  const workspace = await createWorkspaceFactory(tx);
  const admin = await createMemberFactory(tx, workspace.id, "Admin");
  const projects = createProjectActions(tx);
  const app = await projects.createProject.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "App", key: "APP", visibility: "public" });
  // A webhook row cannot be created through the Actions with the flag off, so one is written directly to prove the emitter ignores it.
  const [hook] = await tx.insert(outboundWebhooks).values({ workspaceId: workspace.id, name: "Ignored", url: "https://93.184.216.34/hook", secretSealed: "x", events: ["work_item.created"], createdBy: admin.id }).returning();
  let built = false;
  await emitOutboundEvent(tx, { workspaceId: workspace.id, type: "work_item.created", build: async () => { built = true; return {}; } });
  expect(built).toBe(false);
  await createWorkItemActions(tx).createWorkItem.handler({ userId: admin.id }, { projectId: app.id, title: "Quiet" });
  expect(await tx.select().from(outboundWebhookDeliveries).where(eq(outboundWebhookDeliveries.webhookId, hook!.id))).toHaveLength(0);
  expect(await tx.select().from(jobs).where(eq(jobs.type, outboundJobType))).toHaveLength(0);
}));

test.concurrent("with the flag off a queued outbound job is never handled: the worker has no handler and makes no network call", async () => withRollback(db, async (tx) => {
  const { enqueueJob, runNextJob } = await import("../src");
  await enqueueJob(tx, { type: outboundJobType, payload: { deliveryId: randomUUID() } });
  expect(await runNextJob(tx, createJobHandlers())).toEqual({ status: "idle" });
  const [job] = await tx.select().from(jobs).where(eq(jobs.type, outboundJobType));
  expect(job!.status).toBe("pending");
  expect(job!.attempts).toBe(0);
}));


test.concurrent("with the flag off cleanup scheduling neither enqueues nor registers webhook cleanup", async () => withRollback(db, async (tx) => {
  await scheduleCleanupJobs(tx);
  expect(Object.keys(createJobHandlers())).not.toContain("cleanup_outbound_webhook_deliveries");
  expect(await tx.select().from(jobs).where(eq(jobs.type, "cleanup_outbound_webhook_deliveries"))).toHaveLength(0);
}));
