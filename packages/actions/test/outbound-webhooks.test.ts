import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHmac, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { activities, agents, apiTokens, createDatabase, daemons, jobs, outboundWebhookDeliveries, outboundWebhooks, runs, runtimes, type Database } from "@weft/db";
import { createMemberFactory, createWorkspaceFactory, withRollback } from "../../db/src/test-helpers";
import { checkWebhookUrl, createActionList, createAgentActions, createCommentActions, createOutboundWebhookActions, createProjectActions, createRunActions, createRuntimeDispatchActions, createWorkItemActions, createWorkItemTypeActions, createJobHandlers, deliverOutboundWebhook, emitOutboundEvent, runNextJob, scheduleCleanupJobs, isPrivateAddress, outboundJobType, outboundRetryBackoffMs, signOutboundBody } from "../src";
import { allowedWebhookPorts } from "../src/outbound-webhooks-flag";
import { openSecret } from "../src/integration-secrets";
import { agentActionGroup } from "../src/agent-action-policy";

// These tests turn the flag on for this file only and restore it afterwards; every other file runs with it off.
const flag = "WEFT_OUTBOUND_WEBHOOKS_ENABLED";
let previousFlag: string | undefined;
const { client, db } = createDatabase();
beforeAll(() => { previousFlag = Bun.env[flag]; Bun.env[flag] = "true"; });
afterAll(async () => {
  if (previousFlag === undefined) delete Bun.env[flag]; else Bun.env[flag] = previousFlag;
  await client.end();
});

type Seen = { headers: Record<string, string>; body: string };

/** A local HTTP receiver. responder(n) gives the status for the n-th request (1-based), or "redirect" for a 302. */
function receiver(responder: (count: number) => number | "redirect" = () => 200) {
  const seen: Seen[] = [];
  const server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    fetch: async (request) => {
      const body = await request.text();
      seen.push({ headers: Object.fromEntries(request.headers.entries()), body });
      const answer = responder(seen.length);
      if (answer === "redirect") return new Response("", { status: 302, headers: { location: "https://example.com/elsewhere" } });
      return new Response(answer === 200 ? "received" : "nope", { status: answer });
    },
  });
  return { url: `http://127.0.0.1:${server.port}/hook`, seen, stop: () => server.stop(true) };
}

async function setup(tx: Database) {
  const workspace = await createWorkspaceFactory(tx);
  const admin = await createMemberFactory(tx, workspace.id, "Admin");
  const member = await createMemberFactory(tx, workspace.id, "Member");
  const projects = createProjectActions(tx);
  const items = createWorkItemActions(tx);
  const app = await projects.createProject.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "App", key: "APP", visibility: "public" });
  await projects.addProjectMember.handler({ userId: admin.id }, { projectId: app.id, userId: member.id, role: "Member" });
  // Factories: one may reach private addresses (a local receiver), one may not (the default in production).
  const hooks = createOutboundWebhookActions(tx, { allowPrivateNetworks: true });
  const strict = createOutboundWebhookActions(tx, { allowPrivateNetworks: false });
  const createItem = (title: string) => items.createWorkItem.handler({ userId: member.id }, { projectId: app.id, title });
  const deliveriesOf = (webhookId: string) => tx.select().from(outboundWebhookDeliveries).where(eq(outboundWebhookDeliveries.webhookId, webhookId));
  const [token] = await tx.insert(apiTokens).values({ userId: member.id, name: "Daemon", tokenHash: randomUUID(), tokenPrefix: "weft_daemon", daemonOnly: true, expiresAt: new Date(Date.now() + 86_400_000) }).returning();
  const [daemon] = await tx.insert(daemons).values({ ownerId: member.id, tokenId: token!.id, hostname: "laptop", version: "1.0.0" }).returning();
  const [runtime] = await tx.insert(runtimes).values({ workspaceId: workspace.id, daemonId: daemon!.id, ownerId: member.id, agentCli: "claude", shared: true, lastSeenAt: new Date() }).returning();
  return { workspace, admin, member, app, hooks, strict, createItem, deliveriesOf, tx, daemonId: daemon!.id, runtimeId: runtime!.id };
}

test.concurrent("a created work item is delivered with an HMAC signature the receiver can check, and an idempotency id", async () => withRollback(db, async (tx) => {
  const s = await setup(tx);
  const local = receiver();
  try {
    const created = await s.hooks.createOutboundWebhook.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id, name: "Pipeline", url: local.url, events: ["work_item.created"] });
    const item = await s.createItem("Export report");
    const [delivery] = await s.deliveriesOf(created.id);
    expect(delivery!.eventType).toBe("work_item.created");
    const status = await deliverOutboundWebhook(tx, delivery!.id, { allowPrivateNetworks: true });
    expect(status).toBe("succeeded");
    expect(local.seen).toHaveLength(1);
    const [request] = local.seen;
    const timestamp = Number(request!.headers["x-weft-timestamp"]);
    const expected = `sha256=${createHmac("sha256", created.secret).update(`${timestamp}.${request!.body}`).digest("hex")}`;
    expect(request!.headers["x-weft-signature"]).toBe(expected);
    const body = JSON.parse(request!.body) as { id: string; type: string; data: { workItem: { id: string; key: string; title: string; type: string | null } } };
    expect(request!.headers["x-weft-delivery"]).toBe(body.id);
    expect(body.type).toBe("work_item.created");
    expect(body.data.workItem).toMatchObject({ id: item.id, key: "APP-1", title: "Export report", type: "Task" });
    expect(request!.headers["x-weft-event"]).toBe("work_item.created");
  } finally { local.stop(); }
}));

test.concurrent("a work item event names its type and custom property values by label and kind, never by raw id", async () => withRollback(db, async (tx) => {
  const s = await setup(tx);
  await createProjectActions(tx).setProjectFeatures.handler({ userId: s.admin.id }, { projectId: s.app.id, features: { types: true } });
  const types = createWorkItemTypeActions(tx);
  const [task] = await types.listWorkItemTypes.handler({ userId: s.admin.id }, { projectId: s.app.id });
  const severity = await types.createCustomProperty.handler({ userId: s.admin.id }, { projectId: s.app.id, name: "Severity", kind: "dropdown", options: ["low", "high"], typeIds: [task!.id] });
  const created = await s.hooks.createOutboundWebhook.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id, name: "Typed", url: "https://93.184.216.34/hook", events: ["work_item.created"] });
  await createWorkItemActions(tx).createWorkItem.handler({ userId: s.member.id }, { projectId: s.app.id, title: "Typed item", typeId: task!.id, properties: [{ propertyId: severity.id, value: "high" }] });
  const [delivery] = await s.deliveriesOf(created.id);
  const body = JSON.parse(JSON.stringify(delivery!.payload)) as { data: { workItem: { type: string; properties: Array<{ label: string; kind: string; value: unknown }> } } };
  expect(body.data.workItem.type).toBe("Task");
  expect(body.data.workItem.properties).toEqual([{ label: "Severity", kind: "dropdown", value: "high" }]);
  expect(JSON.stringify(body)).not.toContain(severity.id);
  expect(JSON.stringify(body)).not.toContain(task!.id);
}));

test.concurrent("a comment added to a work item is delivered to a webhook that subscribes to comments", async () => withRollback(db, async (tx) => {
  const s = await setup(tx);
  const local = receiver();
  try {
    const created = await s.hooks.createOutboundWebhook.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id, name: "Comments", url: local.url, events: ["comment.created"] });
    const item = await s.createItem("Review me");
    const comments = createCommentActions(tx);
    await comments.createComment.handler({ userId: s.member.id }, { workItemId: item.id, body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Looks good" }] }] } });
    const [delivery] = await s.deliveriesOf(created.id);
    expect(await deliverOutboundWebhook(tx, delivery!.id, { allowPrivateNetworks: true })).toBe("succeeded");
    const body = JSON.parse(local.seen[0]!.body) as { type: string; data: { comment: { text: string; authorName: string | null }; workItem: { key: string } } };
    expect(body.type).toBe("comment.created");
    expect(body.data.comment.text).toBe("Looks good");
    expect(body.data.workItem.key).toBe("APP-1");
  } finally { local.stop(); }
}));

test.concurrent("a webhook that does not subscribe to an event gets no delivery for it", async () => withRollback(db, async (tx) => {
  const s = await setup(tx);
  const created = await s.hooks.createOutboundWebhook.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id, name: "Only comments", url: "https://93.184.216.34/hook", events: ["comment.created"] });
  await s.createItem("Quiet");
  expect(await s.deliveriesOf(created.id)).toHaveLength(0);
  const disabled = await s.hooks.updateOutboundWebhook.handler({ userId: s.admin.id }, { webhookId: created.id, enabled: false, events: ["work_item.created"] });
  expect(disabled.enabled).toBe(false);
  await s.createItem("Still quiet");
  expect(await s.deliveriesOf(created.id)).toHaveLength(0);
}));

test.concurrent("a failed delivery is retried with backoff, and a redelivery reuses the same event id", async () => withRollback(db, async (tx) => {
  const s = await setup(tx);
  const local = receiver((count) => (count === 1 ? 500 : 200));
  try {
    const created = await s.hooks.createOutboundWebhook.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id, name: "Flaky", url: local.url, events: ["work_item.created"] });
    await s.createItem("Flaky send");
    const [delivery] = await s.deliveriesOf(created.id);
    const t0 = new Date("2030-01-01T00:00:00Z");
    expect(await deliverOutboundWebhook(tx, delivery!.id, { allowPrivateNetworks: true, now: () => t0 })).toBe("retrying");
    const [pending] = await tx.select().from(outboundWebhookDeliveries).where(eq(outboundWebhookDeliveries.id, delivery!.id));
    expect(pending).toMatchObject({ status: "retrying", attempts: 1, responseStatus: 500 });
    expect(pending!.nextAttemptAt?.toISOString()).toBe(new Date(t0.getTime() + outboundRetryBackoffMs[0]!).toISOString());
    const [job] = await tx.select().from(jobs).where(and(eq(jobs.type, outboundJobType), eq(jobs.dedupeKey, `${outboundJobType}:${delivery!.id}:1`)));
    expect(job?.runAt.toISOString()).toBe(new Date(t0.getTime() + outboundRetryBackoffMs[0]!).toISOString());

    const retryAt = new Date(t0.getTime() + outboundRetryBackoffMs[0]!);
    expect(await deliverOutboundWebhook(tx, delivery!.id, { allowPrivateNetworks: true, now: () => retryAt })).toBe("succeeded");
    expect(local.seen.map((seen) => seen.headers["x-weft-delivery"])).toEqual([JSON.parse(local.seen[0]!.body).id, JSON.parse(local.seen[0]!.body).id]);

    const redelivery = await s.hooks.redeliverOutboundWebhookDelivery.handler({ userId: s.admin.id }, { deliveryId: delivery!.id });
    expect(redelivery.status).toBe("pending");
    expect(await deliverOutboundWebhook(tx, delivery!.id, { allowPrivateNetworks: true })).toBe("succeeded");
    expect(local.seen).toHaveLength(3);
    expect(new Set(local.seen.map((seen) => seen.headers["x-weft-delivery"])).size).toBe(1);
    const log = await s.hooks.listOutboundWebhookDeliveries.handler({ userId: s.admin.id }, { webhookId: created.id });
    expect(log[0]).toMatchObject({ status: "succeeded", responseStatus: 200, attempts: 1 });
  } finally { local.stop(); }
}));

test.concurrent("a retry enqueue failure leaves the delivery state unchanged", async () => withRollback(db, async (tx) => {
  const s = await setup(tx);
  const local = receiver(() => 500);
  try {
    const created = await s.hooks.createOutboundWebhook.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id, name: "Atomic retry", url: local.url, events: ["work_item.created"] });
    await s.createItem("Retry atomically");
    const [delivery] = await s.deliveriesOf(created.id);
    const enqueue = async () => { throw new Error("queue unavailable"); };
    await expect(deliverOutboundWebhook(tx, delivery!.id, { allowPrivateNetworks: true, enqueue: enqueue as never })).rejects.toThrow("queue unavailable");
    const [after] = await tx.select().from(outboundWebhookDeliveries).where(eq(outboundWebhookDeliveries.id, delivery!.id));
    expect(after).toMatchObject({ status: "pending", attempts: 0, nextAttemptAt: null, responseStatus: null });
  } finally { local.stop(); }
}));

test.concurrent("after the last attempt a delivery is marked failed and no more retries are queued", async () => withRollback(db, async (tx) => {
  const s = await setup(tx);
  const local = receiver(() => 503);
  try {
    const created = await s.hooks.createOutboundWebhook.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id, name: "Down", url: local.url, events: ["work_item.created"] });
    await s.createItem("Down send");
    const [delivery] = await s.deliveriesOf(created.id);
    const t0 = new Date("2030-02-01T00:00:00Z");
    let at = t0;
    const outcomes: string[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      outcomes.push(await deliverOutboundWebhook(tx, delivery!.id, { allowPrivateNetworks: true, now: () => at }));
      at = new Date(at.getTime() + 86_400_000);
    }
    expect(outcomes).toEqual(["retrying", "retrying", "retrying", "retrying", "retrying", "failed"]);
    expect(local.seen).toHaveLength(6);
    const [final] = await tx.select().from(outboundWebhookDeliveries).where(eq(outboundWebhookDeliveries.id, delivery!.id));
    expect(final).toMatchObject({ status: "failed", attempts: 6, nextAttemptAt: null });
  } finally { local.stop(); }
}));

test.concurrent("a receiver that redirects is not followed, and the delivery fails at once", async () => withRollback(db, async (tx) => {
  const s = await setup(tx);
  const local = receiver(() => "redirect");
  try {
    const created = await s.hooks.createOutboundWebhook.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id, name: "Moved", url: local.url, events: ["work_item.created"] });
    await s.createItem("Redirect send");
    const [delivery] = await s.deliveriesOf(created.id);
    expect(await deliverOutboundWebhook(tx, delivery!.id, { allowPrivateNetworks: true })).toBe("failed");
    const [row] = await tx.select().from(outboundWebhookDeliveries).where(eq(outboundWebhookDeliveries.id, delivery!.id));
    expect(row!.lastError).toContain("Redirects are not followed");
    expect(local.seen).toHaveLength(1);
  } finally { local.stop(); }
}));

test.concurrent("private, loopback and link-local web addresses are refused unless the operator allows them (SSRF)", async () => withRollback(db, async (tx) => {
  const s = await setup(tx);
  const refused = [
    "http://127.0.0.1/hook", "https://127.0.0.1:8443/hook", "https://10.0.0.5/hook", "https://172.16.4.1/hook", "https://192.168.1.10/hook",
    "https://169.254.169.254/latest/meta-data/", "https://100.64.0.9/hook", "https://0.0.0.0/hook", "https://[::1]/hook", "https://[fe80::1]/hook",
    "https://[fd00::5]/hook", "https://[::ffff:127.0.0.1]/hook", "https://[::ffff:7f00:1]/hook", "https://localhost/hook", "https://api.localhost/hook",
    "https://user:secret@93.184.216.34/hook", "ftp://93.184.216.34/hook", "not a url",
  ];
  for (const url of refused) {
    await expect(s.strict.createOutboundWebhook.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id, name: "Bad", url, events: ["work_item.created"] })).rejects.toMatchObject({ status: 400 });
  }
  // A host name that resolves to a private address is refused too.
  await expect(checkWebhookUrl("https://files.example.test/hook", { allowPrivate: false, lookup: async () => ["10.20.30.40"] })).rejects.toMatchObject({ status: 400 });
  await expect(checkWebhookUrl("https://files.example.test/hook", { allowPrivate: false, lookup: async () => ["93.184.216.34"] })).resolves.toBe("https://files.example.test/hook");
  expect(await tx.select().from(outboundWebhooks)).toHaveLength(0);
  // Public literals are accepted.
  await expect(s.strict.createOutboundWebhook.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id, name: "Public", url: "https://93.184.216.34/hook", events: ["work_item.created"] })).resolves.toMatchObject({ name: "Public" });
  // A webhook saved while private networks were allowed is refused at send time once the operator turns that off.
  const local = receiver();
  try {
    const created = await s.hooks.createOutboundWebhook.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id, name: "Local", url: local.url, events: ["work_item.created"] });
    await s.createItem("Blocked send");
    const [delivery] = await s.deliveriesOf(created.id);
    expect(await deliverOutboundWebhook(tx, delivery!.id, { allowPrivateNetworks: false })).toBe("failed");
    expect(local.seen).toHaveLength(0);
  } finally { local.stop(); }
}));

test("the private-address check covers IPv4 and IPv6 ranges and lets public addresses through", () => {
  for (const address of ["127.0.0.1", "10.1.2.3", "172.31.255.255", "192.168.0.1", "169.254.169.254", "100.100.1.1", "0.1.2.3", "224.0.0.1", "::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1", "::ffff:10.0.0.1", "::ffff:a00:1", "64:ff9b::a00:1",
    "192.88.99.1", "198.51.100.7", "203.0.113.9", "198.18.0.1", "198.19.255.255", "::a9fe:a9fe", "::5db8:d822", "fec0::1", "feff::1", "2002:a9fe:a9fe::1", "2002:7f00:1::", "2001::1", "2001:0:4136:e378:8000:63bf:3fff:fdd2", "100::1"]) {
    expect(isPrivateAddress(address)).toBe(true);
  }
  for (const address of ["93.184.216.34", "172.32.0.1", "8.8.8.8", "2606:4700:4700::1111", "::ffff:93.184.216.34", "2002:5db8:d822::1", "198.51.101.1", "203.0.114.1", "198.20.0.1", "100:0:0:1::1"]) {
    expect(isPrivateAddress(address)).toBe(false);
  }
});

test.concurrent("secrets are shown once, stored sealed, and rotation changes what the receiver must check", async () => withRollback(db, async (tx) => {
  const s = await setup(tx);
  const created = await s.hooks.createOutboundWebhook.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id, name: "Keys", url: "https://93.184.216.34/hook", events: ["run.finished"] });
  expect(created.secret).toMatch(/^[0-9a-f]{64}$/);
  const listed = await s.hooks.listOutboundWebhooks.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id });
  expect(JSON.stringify(listed)).not.toContain(created.secret);
  expect(JSON.stringify(listed)).not.toContain("/hook");
  expect(await s.hooks.getOutboundWebhookUrl.handler({ userId: s.admin.id }, { webhookId: created.id })).toEqual({ url: "https://93.184.216.34/hook" });
  await expect(s.hooks.getOutboundWebhookUrl.handler({ userId: s.member.id }, { webhookId: created.id })).rejects.toMatchObject({ status: 403 });
  const [row] = await tx.select().from(outboundWebhooks).where(eq(outboundWebhooks.id, created.id));
  expect(row!.secretSealed).not.toContain(created.secret);
  expect(openSecret(row!.secretSealed)).toBe(created.secret);
  const rotated = await s.hooks.rotateOutboundWebhookSecret.handler({ userId: s.admin.id }, { webhookId: created.id });
  expect(rotated.secret).not.toBe(created.secret);
  const [after] = await tx.select().from(outboundWebhooks).where(eq(outboundWebhooks.id, created.id));
  expect(openSecret(after!.secretSealed)).toBe(rotated.secret);
  expect(signOutboundBody(rotated.secret, 1, "{}")).toBe(`sha256=${createHmac("sha256", rotated.secret).update("1.{}").digest("hex")}`);
}));

test.concurrent("the test button sends one event now, reports the answer, and queues no retry", async () => withRollback(db, async (tx) => {
  const s = await setup(tx);
  const good = receiver();
  const bad = receiver(() => 500);
  try {
    const ok = await s.hooks.createOutboundWebhook.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id, name: "Good", url: good.url, events: ["run.finished"] });
    const result = await s.hooks.testOutboundWebhook.handler({ userId: s.admin.id }, { webhookId: ok.id });
    expect(result).toMatchObject({ status: "succeeded", responseStatus: 200 });
    expect(result.message).toContain("accepted the test event");
    expect(JSON.parse(good.seen[0]!.body).type).toBe("webhook.test");

    const failing = await s.hooks.createOutboundWebhook.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id, name: "Bad", url: bad.url, events: ["run.finished"] });
    const failed = await s.hooks.testOutboundWebhook.handler({ userId: s.admin.id }, { webhookId: failing.id });
    expect(failed).toMatchObject({ status: "failed", responseStatus: 500 });
    expect(failed.message).toContain("not accepted");
    const queued = await tx.select().from(jobs).where(eq(jobs.type, outboundJobType));
    expect(queued.filter((job) => (job.payload as { deliveryId: string }).deliveryId === failed.deliveryId)).toHaveLength(0);
  } finally { good.stop(); bad.stop(); }
}));

test.concurrent("only workspace admins manage webhooks; a member is refused", async () => withRollback(db, async (tx) => {
  const s = await setup(tx);
  await expect(s.hooks.createOutboundWebhook.handler({ userId: s.member.id }, { workspaceId: s.workspace.id, name: "Mine", url: "https://93.184.216.34/hook", events: ["work_item.created"] })).rejects.toMatchObject({ status: 403 });
  const created = await s.hooks.createOutboundWebhook.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id, name: "Admins", url: "https://93.184.216.34/hook", events: ["work_item.created"] });
  await expect(s.hooks.deleteOutboundWebhook.handler({ userId: s.member.id }, { webhookId: created.id })).rejects.toMatchObject({ status: 403 });
  await s.hooks.deleteOutboundWebhook.handler({ userId: s.admin.id }, { webhookId: created.id });
  expect(await tx.select().from(outboundWebhooks).where(eq(outboundWebhooks.id, created.id))).toHaveLength(0);
}));

test.concurrent("a Run that finishes is delivered as run.finished with its status and work item, and no secret or token", async () => withRollback(db, async (tx) => {
  const s = await setup(tx);
  const local = receiver();
  try {
    // A Runtime Run as in run-usage.test.ts: an Agent on the member's Daemon, assigned a work item and finished by the Daemon.
    const agentActions = createAgentActions(tx);
    const agent = await agentActions.createAgent.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id, name: "Runner", model: "default", monthlyTokenBudget: null });
    await agentActions.setAgentProjectAccess.handler({ userId: s.admin.id }, { agentId: agent.id, allProjects: true, projectIds: [] });
    const runtime = { id: s.runtimeId };
    const daemon = { id: s.daemonId };
    await tx.update(agents).set({ runtimeId: runtime.id, cliModel: null }).where(eq(agents.id, agent.id));
    const created = await s.hooks.createOutboundWebhook.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id, name: "Runs", url: local.url, events: ["run.finished"] });
    const item = await createWorkItemActions(tx).createWorkItem.handler({ userId: s.member.id }, { projectId: s.app.id, title: "Ship the report" });
    await createWorkItemActions(tx).updateWorkItem.handler({ userId: s.member.id }, { workItemId: item.id, assigneeIds: [agent.userId] });
    const [run] = await tx.select().from(runs).where(eq(runs.workItemId, item.id));
    const dispatch = createRuntimeDispatchActions(tx);
    // The Daemon's claim and start are covered by run-usage.test.ts; here the Run is put in the running state directly.
    await tx.update(runs).set({ status: "running", runtimeId: runtime.id, startedAt: new Date() }).where(eq(runs.id, run!.id));
    await dispatch.finishRun(run!.id, { status: "completed", finalOutput: "Done." });
    const [delivery] = await s.deliveriesOf(created.id);
    expect(delivery!.eventType).toBe("run.finished");
    expect(await deliverOutboundWebhook(tx, delivery!.id, { allowPrivateNetworks: true })).toBe("succeeded");
    const body = JSON.parse(local.seen[0]!.body) as { type: string; data: { run: { id: string; status: string }; workItem: { key: string; title: string } } };
    expect(body.type).toBe("run.finished");
    expect(body.data.run).toMatchObject({ id: run!.id, status: "completed" });
    expect(body.data.workItem).toMatchObject({ key: "APP-1", title: "Ship the report" });
    expect(local.seen[0]!.body).not.toContain(s.daemonId);
  } finally { local.stop(); }
}));

test.concurrent("a run.finished insert failure rolls back finish and usage, then retry emits exactly one event", async () => withRollback(db, async (tx) => {
  const s = await setup(tx);
  const agentActions = createAgentActions(tx);
  const agent = await agentActions.createAgent.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id, name: "Retry finish", model: "default", monthlyTokenBudget: null });
  await agentActions.setAgentProjectAccess.handler({ userId: s.admin.id }, { agentId: agent.id, allProjects: true, projectIds: [] });
  await tx.update(agents).set({ runtimeId: s.runtimeId }).where(eq(agents.id, agent.id));
  const webhook = await s.hooks.createOutboundWebhook.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id, name: "Run finish", url: "https://93.184.216.34/hook", events: ["run.finished"] });
  const item = await createWorkItemActions(tx).createWorkItem.handler({ userId: s.member.id }, { projectId: s.app.id, title: "Retry finish event" });
  await createWorkItemActions(tx).updateWorkItem.handler({ userId: s.member.id }, { workItemId: item.id, assigneeIds: [agent.userId] });
  const [run] = await tx.select().from(runs).where(eq(runs.workItemId, item.id));
  await tx.update(runs).set({ status: "running", runtimeId: s.runtimeId, startedAt: new Date() }).where(eq(runs.id, run!.id));
  await tx.execute(sql`CREATE FUNCTION fail_run_finished_delivery() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type = 'run.finished' THEN RAISE EXCEPTION 'injected run.finished insert failure'; END IF; RETURN NEW; END; $$`);
  await tx.execute(sql`CREATE TRIGGER fail_run_finished_delivery BEFORE INSERT ON outbound_webhook_deliveries FOR EACH ROW EXECUTE FUNCTION fail_run_finished_delivery()`);
  const dispatch = createRuntimeDispatchActions(tx);
  const outcome = { status: "completed" as const, finalOutput: "Done.", usage: { inputTokens: 7, outputTokens: 3 } };
  await expect(dispatch.finishRun(run!.id, outcome)).rejects.toThrow();
  const [afterFailure] = await tx.select().from(runs).where(eq(runs.id, run!.id));
  expect(afterFailure).toMatchObject({ status: "running", usageReported: false, inputTokens: 0, outputTokens: 0, finishedAt: null });
  expect(await s.deliveriesOf(webhook.id)).toHaveLength(0);
  await tx.execute(sql`DROP TRIGGER fail_run_finished_delivery ON outbound_webhook_deliveries`);
  await tx.execute(sql`DROP FUNCTION fail_run_finished_delivery()`);
  await dispatch.finishRun(run!.id, outcome);
  const deliveries = await s.deliveriesOf(webhook.id);
  expect(deliveries).toHaveLength(1);
  expect((deliveries[0]!.payload as { data: { run: { id: string; status: string } } }).data.run).toMatchObject({ id: run!.id, status: "completed" });
}));

test.concurrent("queued and dispatched Runs cancel directly, running Runs stop, and real terminal transitions emit once", async () => withRollback(db, async (tx) => {
  const s = await setup(tx);
  const agentActions = createAgentActions(tx);
  const agent = await agentActions.createAgent.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id, name: "Cancel runner", model: "default", monthlyTokenBudget: null });
  await agentActions.setAgentProjectAccess.handler({ userId: s.admin.id }, { agentId: agent.id, allProjects: true, projectIds: [] });
  await tx.update(agents).set({ runtimeId: s.runtimeId }).where(eq(agents.id, agent.id));
  const webhook = await s.hooks.createOutboundWebhook.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id, name: "Run endings", url: "https://93.184.216.34/hook", events: ["run.finished"] });
  const dispatch = createRuntimeDispatchActions(tx);
  const makeRun = async (title: string) => {
    const item = await createWorkItemActions(tx).createWorkItem.handler({ userId: s.member.id }, { projectId: s.app.id, title });
    await createWorkItemActions(tx).updateWorkItem.handler({ userId: s.member.id }, { workItemId: item.id, assigneeIds: [agent.userId] });
    const [run] = await tx.select().from(runs).where(eq(runs.workItemId, item.id));
    return run!;
  };
  const queued = await makeRun("Cancel queued directly");
  await createRunActions(tx).cancelRun.handler({ userId: s.member.id }, { runId: queued.id });
  await expect(createRunActions(tx).cancelRun.handler({ userId: s.member.id }, { runId: queued.id })).rejects.toMatchObject({ status: 409 });
  const cancelled = await makeRun("Cancel directly");
  await tx.update(runs).set({ status: "dispatched", runtimeId: s.runtimeId }).where(eq(runs.id, cancelled.id));
  await createRunActions(tx).cancelRun.handler({ userId: s.member.id }, { runId: cancelled.id });
  const waitingOnDaemon = await makeRun("Cancel waiting on daemon");
  await tx.update(runs).set({ status: "awaiting_input", runtimeId: s.runtimeId }).where(eq(runs.id, waitingOnDaemon.id));
  await createRunActions(tx).cancelRun.handler({ userId: s.member.id }, { runId: waitingOnDaemon.id });
  expect((await tx.select().from(runs).where(eq(runs.id, waitingOnDaemon.id)))[0]?.status).toBe("stopping");
  await dispatch.acknowledgeCancel(waitingOnDaemon.id);
  const acknowledged = await makeRun("Cancel acknowledged");
  await tx.update(runs).set({ status: "running", runtimeId: s.runtimeId }).where(eq(runs.id, acknowledged.id));
  await createRunActions(tx).cancelRun.handler({ userId: s.member.id }, { runId: acknowledged.id });
  await dispatch.acknowledgeCancel(acknowledged.id);
  const finishedWhileStopping = await makeRun("Finish while stopping");
  await tx.update(runs).set({ status: "running", runtimeId: s.runtimeId }).where(eq(runs.id, finishedWhileStopping.id));
  await createRunActions(tx).cancelRun.handler({ userId: s.member.id }, { runId: finishedWhileStopping.id });
  await dispatch.finishRun(finishedWhileStopping.id, { status: "completed", finalOutput: "late result" });
  const deliveries = await s.deliveriesOf(webhook.id);
  expect(deliveries).toHaveLength(5);
  expect(new Set(deliveries.map((row) => row.eventId)).size).toBe(5);
  expect(deliveries.map((row) => (row.payload as { data: { run: { status: string } } }).data.run.status).sort()).toEqual(["cancelled", "cancelled", "cancelled", "cancelled", "cancelled"]);
}));

test("Agents are refused every webhook Action: URLs, signing secrets and deliveries are people-only", () => {
  const webhookActions = createActionList({} as never, { outboundWebhooks: true }).map((action) => action.name).filter((name) => name.includes("outbound_webhook"));
  expect(webhookActions).toHaveLength(8);
  for (const name of webhookActions) expect(agentActionGroup(name)).toBe("denied");
});

test("the webhook Actions are listed only when the flag is on, and Agents are refused them", () => {
  const names = (options: { outboundWebhooks?: boolean }) => createActionList({} as never, options).map((action) => action.name);
  expect(names({ outboundWebhooks: true })).toContain("create_outbound_webhook");
  expect(names({ outboundWebhooks: false })).not.toContain("create_outbound_webhook");
  expect(names({})).toContain("create_outbound_webhook");
});


test.concurrent("a webhook may use port 443, 80 or 8443 only, unless the operator adds more; private-network mode is not limited", async () => withRollback(db, async (tx) => {
  const s = await setup(tx);
  const create = (url: string) => s.strict.createOutboundWebhook.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id, name: "Ports", url, events: ["work_item.created"] });
  await expect(create("https://93.184.216.34:6379/hook")).rejects.toMatchObject({ status: 400 });
  await expect(create("https://93.184.216.34:22/hook")).rejects.toMatchObject({ status: 400 });
  await expect(create("https://93.184.216.34:8443/hook")).resolves.toMatchObject({ name: "Ports" });
  await expect(create("https://93.184.216.34/hook")).resolves.toMatchObject({ name: "Ports" });
  const previous = Bun.env.WEFT_OUTBOUND_WEBHOOKS_ALLOW_PORTS;
  try {
    expect(allowedWebhookPorts({ WEFT_OUTBOUND_WEBHOOKS_ALLOW_PORTS: "9000, 9443,abc,70000" })).toEqual([80, 443, 8443, 9000, 9443]);
    expect(allowedWebhookPorts({})).toEqual([80, 443, 8443]);
    await expect(checkWebhookUrl("https://93.184.216.34:9000/hook", { allowPrivate: false })).rejects.toMatchObject({ status: 400 });
    Bun.env.WEFT_OUTBOUND_WEBHOOKS_ALLOW_PORTS = "9000";
    await expect(checkWebhookUrl("https://93.184.216.34:9000/hook", { allowPrivate: false })).resolves.toContain(":9000");
  } finally { if (previous === undefined) delete Bun.env.WEFT_OUTBOUND_WEBHOOKS_ALLOW_PORTS; else Bun.env.WEFT_OUTBOUND_WEBHOOKS_ALLOW_PORTS = previous; }
  await expect(s.hooks.createOutboundWebhook.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id, name: "Local", url: "http://127.0.0.1:5999/hook", events: ["work_item.created"] })).resolves.toMatchObject({ name: "Local" });
}));

test.concurrent("the test button says only that the receiver could not be reached, whether the port is closed or filtered", async () => withRollback(db, async (tx) => {
  const s = await setup(tx);
  const created = await s.hooks.createOutboundWebhook.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id, name: "Closed", url: "http://127.0.0.1:1/hook", events: ["run.finished"] });
  const closed = await s.hooks.testOutboundWebhook.handler({ userId: s.admin.id }, { webhookId: created.id });
  expect(closed.message).toContain("could not be reached");
  expect(closed.message).not.toMatch(/ECONNREFUSED|refused|timed out/i);
  // A connect timeout (a filtered port) reads the same as a refused connection.
  const [first] = await tx.select().from(outboundWebhookDeliveries).where(eq(outboundWebhookDeliveries.webhookId, created.id));
  const unreachable = await deliverOutboundWebhook(tx, first!.id, { allowPrivateNetworks: true, transport: async () => { const error = new Error("connect timed out"); error.name = "TimeoutError"; throw error; } });
  expect(unreachable).toBe("retrying");
  const [row] = await tx.select().from(outboundWebhookDeliveries).where(eq(outboundWebhookDeliveries.webhookId, created.id)).limit(1);
  expect(row!.lastError).toBe("The receiver could not be reached");
}));

const statusTransport = (status: number) => async () => ({ status, excerpt: null });

test.concurrent("a webhook is turned off after 10 failed deliveries in a row, says why, and an Admin turns it back on", async () => withRollback(db, async (tx) => {
  const s = await setup(tx);
  const created = await s.hooks.createOutboundWebhook.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id, name: "Dead", url: "https://93.184.216.34/hook", events: ["work_item.created"] });
  for (let index = 0; index < 11; index += 1) await s.createItem(`Item ${index}`);
  const deliveries = await s.deliveriesOf(created.id);
  expect(deliveries).toHaveLength(11);
  // A redirect fails a delivery at once, so each send is one failure.
  for (const delivery of deliveries.slice(0, 9)) expect(await deliverOutboundWebhook(tx, delivery.id, { allowPrivateNetworks: true, transport: statusTransport(302) })).toBe("failed");
  const [row9] = await tx.select().from(outboundWebhooks).where(eq(outboundWebhooks.id, created.id));
  expect(row9).toMatchObject({ enabled: true, consecutiveFailures: 9, disabledReason: null });
  // A success resets the streak.
  expect(await deliverOutboundWebhook(tx, deliveries[9]!.id, { allowPrivateNetworks: true, transport: statusTransport(200) })).toBe("succeeded");
  expect((await tx.select().from(outboundWebhooks).where(eq(outboundWebhooks.id, created.id)))[0]).toMatchObject({ enabled: true, consecutiveFailures: 0 });
  // Ten more failures in a row turn it off.
  for (let index = 0; index < 10; index += 1) {
    await s.createItem(`More ${index}`);
  }
  const more = (await s.deliveriesOf(created.id)).filter((delivery) => delivery.status === "pending");
  expect(more.length).toBeGreaterThanOrEqual(10);
  for (const delivery of more.slice(0, 10)) await deliverOutboundWebhook(tx, delivery.id, { allowPrivateNetworks: true, transport: statusTransport(302) });
  const [off] = await s.hooks.listOutboundWebhooks.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id });
  expect(off).toMatchObject({ enabled: false, disabledReason: "failures" });
  const audit = await tx.select().from(activities).where(eq(activities.field, "outbound_webhook.auto_disabled"));
  expect(audit).toHaveLength(1);
  const before = (await s.deliveriesOf(created.id)).length;
  await s.createItem("After off");
  expect(await s.deliveriesOf(created.id)).toHaveLength(before);
  const on = await s.hooks.updateOutboundWebhook.handler({ userId: s.admin.id }, { webhookId: created.id, enabled: true });
  expect(on).toMatchObject({ enabled: true, disabledReason: null });
  expect((await tx.select().from(outboundWebhooks).where(eq(outboundWebhooks.id, created.id)))[0]!.consecutiveFailures).toBe(0);
}));

test.concurrent("the creator's role and project access are loaded once per event, however many webhooks subscribe", async () => withRollback(db, async (tx) => {
  const s = await setup(tx);
  const hook = (name: string) => s.hooks.createOutboundWebhook.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id, name, url: "https://93.184.216.34/hook", events: ["comment.created"] });
  const selects = async () => {
    let count = 0;
    const counting = new Proxy(tx, { get: (target, key) => { const value = Reflect.get(target, key, target); return typeof value === "function" ? (...args: unknown[]) => { if (key === "select") count += 1; return (value as (...a: unknown[]) => unknown).apply(target, args); } : value; } });
    await emitOutboundEvent(counting as Database, { workspaceId: s.workspace.id, projectId: s.app.id, type: "comment.created", build: async () => ({}) });
    return count;
  };
  await hook("One");
  const one = await selects();
  await hook("Two");
  await hook("Three");
  expect(await selects()).toBe(one);
}));

test.concurrent("emitting an event never throws into the write: a payload that cannot be built leaves failed deliveries", async () => withRollback(db, async (tx) => {
  const s = await setup(tx);
  const created = await s.hooks.createOutboundWebhook.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id, name: "Broken", url: "https://93.184.216.34/hook", events: ["comment.created"] });
  await expect(emitOutboundEvent(tx, { workspaceId: s.workspace.id, projectId: s.app.id, type: "comment.created", build: async () => { throw new Error("boom"); } })).resolves.toBeUndefined();
  const [delivery] = await s.deliveriesOf(created.id);
  expect(delivery).toMatchObject({ status: "failed", eventType: "comment.created" });
  expect(delivery!.lastError).toContain("could not be prepared");
  // The surrounding transaction still works.
  await expect(s.createItem("Still writes")).resolves.toMatchObject({ title: "Still writes" });
}));

test.concurrent("a failing SQL statement during event payload building rolls back its savepoint and preserves the surrounding write", async () => withRollback(db, async (tx) => {
  const s = await setup(tx);
  await s.hooks.createOutboundWebhook.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id, name: "SQL failure", url: "https://93.184.216.34/hook", events: ["work_item.created"] });
  await emitOutboundEvent(tx, { workspaceId: s.workspace.id, type: "work_item.created", projectId: s.app.id, build: async (database) => {
    await database.execute(sql`select * from table_that_does_not_exist`);
    return {};
  } });
  await expect(s.createItem("Still writes after SQL failure")).resolves.toMatchObject({ title: "Still writes after SQL failure" });
}));

test.concurrent("the webhook list and the audit log show the address without its path and query", async () => withRollback(db, async (tx) => {
  const s = await setup(tx);
  const created = await s.hooks.createOutboundWebhook.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id, name: "Masked", url: "https://93.184.216.34/services/T000/B000/xoxb-secret?token=abc", events: ["work_item.created"] });
  const [listed] = await s.hooks.listOutboundWebhooks.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id });
  expect(listed!.displayUrl).toBe("https://93.184.216.34/…");
  expect(JSON.stringify(listed)).not.toContain("xoxb-secret");
  expect(await s.hooks.getOutboundWebhookUrl.handler({ userId: s.admin.id }, { webhookId: created.id })).toEqual({ url: "https://93.184.216.34/services/T000/B000/xoxb-secret?token=abc" });
  await s.hooks.updateOutboundWebhook.handler({ userId: s.admin.id }, { webhookId: created.id, url: "https://93.184.216.35/other/path?key=zzz" });
  const audit = await tx.select().from(activities).where(eq(activities.field, "outbound_webhook.url"));
  expect(audit).toHaveLength(1);
  expect(audit[0]).toMatchObject({ oldValue: "https://93.184.216.34/…", newValue: "https://93.184.216.35/…" });
  expect(JSON.stringify(audit)).not.toMatch(/secret|token|zzz|other/);
}));

test.concurrent("Redeliver is refused while a delivery is retrying, and repeated clicks queue one job", async () => withRollback(db, async (tx) => {
  const s = await setup(tx);
  const created = await s.hooks.createOutboundWebhook.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id, name: "Redo", url: "https://93.184.216.34/hook", events: ["work_item.created"] });
  await s.createItem("Redo me");
  const [delivery] = await s.deliveriesOf(created.id);
  expect(await deliverOutboundWebhook(tx, delivery!.id, { allowPrivateNetworks: true, transport: statusTransport(500) })).toBe("retrying");
  await expect(s.hooks.redeliverOutboundWebhookDelivery.handler({ userId: s.admin.id }, { deliveryId: delivery!.id })).rejects.toMatchObject({ status: 409 });
  expect(await deliverOutboundWebhook(tx, delivery!.id, { allowPrivateNetworks: true, transport: statusTransport(200) })).toBe("succeeded");
  const open = async () => (await tx.select().from(jobs).where(eq(jobs.type, outboundJobType))).filter((job) => (job.payload as { deliveryId: string }).deliveryId === delivery!.id && String(job.dedupeKey).endsWith(":redeliver"));
  await s.hooks.redeliverOutboundWebhookDelivery.handler({ userId: s.admin.id }, { deliveryId: delivery!.id });
  await s.hooks.redeliverOutboundWebhookDelivery.handler({ userId: s.admin.id }, { deliveryId: delivery!.id });
  await s.hooks.redeliverOutboundWebhookDelivery.handler({ userId: s.admin.id }, { deliveryId: delivery!.id });
  expect(await open()).toHaveLength(1);
}));

test.concurrent("redelivery enqueue failure rolls the delivery back and a later click queues it", async () => withRollback(db, async (tx) => {
  const s = await setup(tx);
  const created = await s.hooks.createOutboundWebhook.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id, name: "Atomic redelivery", url: "https://93.184.216.34/hook", events: ["work_item.created"] });
  await s.createItem("redelivery");
  const [delivery] = await s.deliveriesOf(created.id);
  await tx.update(outboundWebhookDeliveries).set({ status: "failed", attempts: 3, lastError: "receiver unavailable" }).where(eq(outboundWebhookDeliveries.id, delivery!.id));
  const failing = createOutboundWebhookActions(tx, { allowPrivateNetworks: true, enqueue: (async () => { throw new Error("queue unavailable"); }) as never });
  await expect(failing.redeliverOutboundWebhookDelivery.handler({ userId: s.admin.id }, { deliveryId: delivery!.id })).rejects.toThrow("queue unavailable");
  expect((await tx.select().from(outboundWebhookDeliveries).where(eq(outboundWebhookDeliveries.id, delivery!.id)))[0]).toMatchObject({ status: "failed", attempts: 3, lastError: "receiver unavailable" });
  await s.hooks.redeliverOutboundWebhookDelivery.handler({ userId: s.admin.id }, { deliveryId: delivery!.id });
  expect((await tx.select().from(outboundWebhookDeliveries).where(eq(outboundWebhookDeliveries.id, delivery!.id)))[0]).toMatchObject({ status: "pending", attempts: 0, lastError: null });
  expect(await tx.select().from(jobs).where(and(eq(jobs.type, outboundJobType), eq(jobs.dedupeKey, `${outboundJobType}:${delivery!.id}:redeliver`)))).toHaveLength(1);
}));

test.concurrent("EAI_AGAIN and ETIMEDOUT retry webhooks with backoff, while blocked DNS addresses are permanent", async () => withRollback(db, async (tx) => {
  const s = await setup(tx);
  const ids: string[] = [];
  for (const code of ["EAI_AGAIN", "ETIMEDOUT"]) {
    const hook = await s.hooks.createOutboundWebhook.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id, name: code, url: "https://93.184.216.34/hook", events: ["work_item.created"] });
    await tx.update(outboundWebhooks).set({ url: `https://${code.toLowerCase()}.example.test/hook` }).where(eq(outboundWebhooks.id, hook.id));
    await s.createItem(`retry ${code}`);
    const [delivery] = await s.deliveriesOf(hook.id);
    const lookup = async () => { throw Object.assign(new Error("temporary dns error"), { code }); };
    expect(await deliverOutboundWebhook(tx, delivery!.id, { lookup })).toBe("retrying");
    expect((await tx.select().from(outboundWebhookDeliveries).where(eq(outboundWebhookDeliveries.id, delivery!.id)))[0]).toMatchObject({ status: "retrying", attempts: 1 });
    ids.push(delivery!.id);
  }
  const blocked = await s.hooks.createOutboundWebhook.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id, name: "Blocked", url: "https://93.184.216.34/hook", events: ["work_item.created"] });
  await tx.update(outboundWebhooks).set({ url: "https://private.example.test/hook" }).where(eq(outboundWebhooks.id, blocked.id));
  await s.createItem("blocked address");
  const [delivery] = await s.deliveriesOf(blocked.id);
  expect(await deliverOutboundWebhook(tx, delivery!.id, { lookup: async () => ["10.0.0.5"] })).toBe("failed");
  expect((await tx.select().from(outboundWebhookDeliveries).where(eq(outboundWebhookDeliveries.id, delivery!.id)))[0]).toMatchObject({ status: "failed", attempts: 1, nextAttemptAt: null });
  const retryJobs = await tx.select().from(jobs).where(eq(jobs.type, outboundJobType));
  expect(retryJobs.filter((job) => ids.includes((job.payload as { deliveryId: string }).deliveryId) && String(job.dedupeKey).endsWith(":1"))).toHaveLength(2);
}));

test.concurrent("webhook delivery jobs are capped at 2 running at once, so other job types are still claimed", async () => withRollback(db, async (tx) => {
  const ran: string[] = [];
  const handlers = {
    [outboundJobType]: async () => { ran.push("webhook"); },
    cap_test_other: async () => { ran.push("other"); },
  };
  const past = new Date(Date.now() - 60_000);
  // Two webhook jobs hold the cap (fresh locks); a third waits, and an other-type job was queued after it.
  await tx.insert(jobs).values([
    { type: outboundJobType, payload: {}, status: "running", lockedAt: new Date(), runAt: past },
    { type: outboundJobType, payload: {}, status: "running", lockedAt: new Date(), runAt: past },
    { type: outboundJobType, payload: { n: 3 }, status: "pending", runAt: new Date(past.getTime() + 1000) },
    { type: "cap_test_other", payload: {}, status: "pending", runAt: new Date(past.getTime() + 2000) },
  ]);
  expect((await runNextJob(tx, handlers)).status).toBe("succeeded");
  expect(ran).toEqual(["other"]);
  // Nothing else is runnable while the cap is full.
  expect(await runNextJob(tx, handlers)).toEqual({ status: "idle" });
  // A running job whose lock went stale no longer holds a slot.
  await tx.update(jobs).set({ lockedAt: new Date(Date.now() - 10 * 60_000) }).where(and(eq(jobs.type, outboundJobType), eq(jobs.status, "running")));
  const next = await runNextJob(tx, handlers);
  expect(next.status).toBe("succeeded");
  expect(ran).toContain("webhook");
}));

test.concurrent("the cleanup job deletes finished deliveries older than 30 days and keeps newer and unfinished ones", async () => withRollback(db, async (tx) => {
  const s = await setup(tx);
  const created = await s.hooks.createOutboundWebhook.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id, name: "Old", url: "https://93.184.216.34/hook", events: ["run.finished"] });
  const now = new Date("2031-06-01T00:00:00Z");
  const day = 86_400_000;
  const row = (age: number, status: string) => ({ webhookId: created.id, workspaceId: s.workspace.id, eventId: randomUUID(), eventType: "run.finished", payload: {}, status, createdAt: new Date(now.getTime() - age * day) });
  await tx.insert(outboundWebhookDeliveries).values([row(31, "succeeded"), row(45, "failed"), row(29, "succeeded"), row(40, "retrying"), row(1, "failed")]);
  await createJobHandlers(undefined, { now: () => now }).cleanup_outbound_webhook_deliveries!(tx, {}, { id: "j", type: "cleanup_outbound_webhook_deliveries" });
  const left = await s.deliveriesOf(created.id);
  expect(left.map((delivery) => delivery.status).sort()).toEqual(["failed", "retrying", "succeeded"]);
  expect(left.every((delivery) => delivery.status === "retrying" || now.getTime() - delivery.createdAt.getTime() <= 30 * day)).toBe(true);
  // It is scheduled like the other cleanup jobs.
  await scheduleCleanupJobs(tx);
  expect((await tx.select().from(jobs).where(eq(jobs.type, "cleanup_outbound_webhook_deliveries"))).length).toBeGreaterThanOrEqual(1);
}));
