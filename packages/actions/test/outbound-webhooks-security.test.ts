import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID, createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { agents, apiTokens, createDatabase, daemons, outboundWebhookDeliveries, outboundWebhooks, runs, runtimes, type Database } from "@weft/db";
import { createMemberFactory, createWorkspaceFactory, withRollback } from "../../db/src/test-helpers";
import { createAgentActions, createMemberActions, createOutboundWebhookActions, createProjectActions, createRunActions, createWorkItemActions, deliverOutboundWebhook } from "../src";
import { pinnedTransport, type WebhookRequest } from "../src/outbound-webhook-transport";
import { openSecret } from "../src/integration-secrets";
import { signOutboundBody } from "../src";

// Security and revocation rules for outbound webhooks. This file runs with the flag on; see outbound-webhooks.test.ts.
const flag = "WEFT_OUTBOUND_WEBHOOKS_ENABLED";
let previousFlag: string | undefined;
const { client, db } = createDatabase();
beforeAll(() => { previousFlag = Bun.env[flag]; Bun.env[flag] = "true"; });
afterAll(async () => {
  if (previousFlag === undefined) delete Bun.env[flag]; else Bun.env[flag] = previousFlag;
  await client.end();
});

const publicAddress = "93.184.216.34";
const privateAddress = "10.0.0.5";

/** Records every transport call; answers 200 unless told otherwise. */
function spyTransport(status = 200) {
  const calls: WebhookRequest[] = [];
  return { calls, transport: async (request: WebhookRequest) => { calls.push(request); return { status, excerpt: "ok" }; } };
}

/** A lookup stub that answers with the given list for each call, in order; the last answer repeats. */
function resolver(...answers: string[][]) {
  let count = 0;
  const lookup = async () => { count += 1; return answers[Math.min(count, answers.length) - 1]!; };
  return { lookup, calls: () => count };
}

async function setup(tx: Database) {
  const workspace = await createWorkspaceFactory(tx);
  const admin = await createMemberFactory(tx, workspace.id, "Admin");
  const member = await createMemberFactory(tx, workspace.id, "Member");
  const projects = createProjectActions(tx);
  const app = await projects.createProject.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "App", key: "APP", visibility: "public" });
  const secret = await projects.createProject.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Secret", key: "SEC", visibility: "private" });
  await projects.addProjectMember.handler({ userId: admin.id }, { projectId: app.id, userId: member.id, role: "Member" });
  const items = createWorkItemActions(tx);
  return {
    workspace, admin, member, app, secret, tx,
    item: (projectId: string, title: string, userId = admin.id) => items.createWorkItem.handler({ userId }, { projectId, title }),
    deliveriesOf: (webhookId: string) => tx.select().from(outboundWebhookDeliveries).where(eq(outboundWebhookDeliveries.webhookId, webhookId)),
  };
}

const hooksWith = (tx: Database, lookup: (hostname: string) => Promise<string[]>) => createOutboundWebhookActions(tx, { lookup });

// --- 1. DNS rebinding ---

test.concurrent("DNS rebinding: a name that answers public at save and private at send is refused, and nothing is sent", async () => withRollback(db, async (tx) => {
  const s = await setup(tx);
  const dns = resolver([publicAddress], [privateAddress]);
  const created = await hooksWith(tx, dns.lookup).createOutboundWebhook.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id, name: "Rebind", url: "https://files.example.test/hook", events: ["work_item.created"] });
  await s.item(s.app.id, "Rebound");
  const [delivery] = await s.deliveriesOf(created.id);
  const sent = spyTransport();
  expect(await deliverOutboundWebhook(tx, delivery!.id, { lookup: dns.lookup, transport: sent.transport })).toBe("failed");
  expect(dns.calls()).toBe(2);
  expect(sent.calls).toHaveLength(0);
  const [row] = await tx.select().from(outboundWebhookDeliveries).where(eq(outboundWebhookDeliveries.id, delivery!.id));
  expect(row!.lastError).toContain("private or local network");
}));

test.concurrent("DNS rebinding: one answer that mixes a public and a private address is refused, not partly used", async () => withRollback(db, async (tx) => {
  const s = await setup(tx);
  const created = await hooksWith(tx, resolver([publicAddress]).lookup).createOutboundWebhook.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id, name: "Mixed", url: "https://files.example.test/hook", events: ["work_item.created"] });
  await s.item(s.app.id, "Mixed answer");
  const [delivery] = await s.deliveriesOf(created.id);
  const sent = spyTransport();
  expect(await deliverOutboundWebhook(tx, delivery!.id, { lookup: resolver([publicAddress, privateAddress]).lookup, transport: sent.transport })).toBe("failed");
  expect(sent.calls).toHaveLength(0);
}));

test.concurrent("the address resolved at send time is pinned: one lookup per send and the validated address is what connects", async () => withRollback(db, async (tx) => {
  const s = await setup(tx);
  const dns = resolver([publicAddress]);
  const created = await hooksWith(tx, dns.lookup).createOutboundWebhook.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id, name: "Pinned", url: "https://files.example.test/hook", events: ["work_item.created"] });
  await s.item(s.app.id, "Pinned send");
  const [delivery] = await s.deliveriesOf(created.id);
  const before = dns.calls();
  const sent = spyTransport();
  expect(await deliverOutboundWebhook(tx, delivery!.id, { lookup: dns.lookup, transport: sent.transport })).toBe("succeeded");
  expect(dns.calls() - before).toBe(1);
  expect(sent.calls[0]!.target).toMatchObject({ hostname: "files.example.test", address: publicAddress, family: 4 });
  expect(sent.calls[0]!.target.url).toBe("https://files.example.test/hook");
}));

test("the pinned transport connects to the validated address but keeps the host name in Host", async () => {
  const seen: Array<{ host: string | null; path: string }> = [];
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (request) => { seen.push({ host: request.headers.get("host"), path: new URL(request.url).pathname }); return new Response("ok"); } });
  try {
    const response = await pinnedTransport({
      target: { url: `http://rebind.example.test:${server.port}/hook`, hostname: "rebind.example.test", address: "127.0.0.1", family: 4 },
      headers: { "content-type": "application/json" }, body: "{}", timeoutMs: 5000,
    });
    expect(response.status).toBe(200);
    expect(seen).toEqual([{ host: `rebind.example.test:${server.port}`, path: "/hook" }]);
  } finally { server.stop(true); }
});

test("the pinned transport never follows a redirect", async () => {
  const seen: string[] = [];
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (request) => {
    seen.push(new URL(request.url).pathname);
    return new Response("", { status: 302, headers: { location: `http://127.0.0.1:1/elsewhere` } });
  } });
  try {
    const response = await pinnedTransport({ target: { url: `http://127.0.0.1:${server.port}/hook`, hostname: "127.0.0.1", address: "127.0.0.1", family: 4 }, headers: {}, body: "{}", timeoutMs: 5000 });
    expect(response.status).toBe(302);
    expect(seen).toEqual(["/hook"]);
  } finally { server.stop(true); }
});

test("a receiver that trickles bytes forever is cut off at the overall deadline, not held by the idle timeout", async () => {
  let open = true;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(new ReadableStream({
    async start(controller) {
      controller.enqueue(new TextEncoder().encode("."));
      while (open) { await Bun.sleep(50); try { controller.enqueue(new TextEncoder().encode("x")); } catch { return; } }
    },
    cancel() { open = false; },
  })) });
  try {
    const started = Date.now();
    // Bytes arrive every 50 ms, so the 5 s idle limit never fires; the 600 ms deadline must end the send.
    const outcome = await pinnedTransport({ target: { url: `http://127.0.0.1:${server.port}/hook`, hostname: "127.0.0.1", address: "127.0.0.1", family: 4 }, headers: {}, body: "{}", timeoutMs: 5000, deadlineMs: 600 }).then(() => "answered", (error: Error) => error.name);
    const elapsed = Date.now() - started;
    expect(outcome).toBe("TimeoutError");
    expect(elapsed).toBeGreaterThanOrEqual(500);
    expect(elapsed).toBeLessThan(2000);
  } finally { open = false; server.stop(true); }
});

test("a receiver that sends a huge body is read only up to 4 KB, then the send ends quickly", async () => {
  let open = true;
  const chunk = new TextEncoder().encode("y".repeat(1024));
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(new ReadableStream({
    async pull(controller) { if (!open) return; controller.enqueue(chunk); await Bun.sleep(1); },
    cancel() { open = false; },
  })) });
  try {
    const started = Date.now();
    const response = await pinnedTransport({ target: { url: `http://127.0.0.1:${server.port}/hook`, hostname: "127.0.0.1", address: "127.0.0.1", family: 4 }, headers: {}, body: "{}", timeoutMs: 5000, deadlineMs: 5000 });
    expect(response.status).toBe(200);
    expect(response.excerpt).toBe("y".repeat(500));
    expect(Date.now() - started).toBeLessThan(1500);
  } finally { open = false; server.stop(true); }
});

test("opening a connection that never completes fails at the connect timeout", async () => {
  // 192.0.2.1 (TEST-NET-1) is not routable: the SYN gets no answer. Skip quietly where the network answers differently (reset at once).
  const started = Date.now();
  const outcome = await pinnedTransport({ target: { url: "http://192.0.2.1:81/hook", hostname: "192.0.2.1", address: "192.0.2.1", family: 4 }, headers: {}, body: "{}", timeoutMs: 8000, deadlineMs: 8000, connectTimeoutMs: 400 }).then(() => "answered", (error: Error) => error.name === "TimeoutError" ? "timeout" : "other");
  const elapsed = Date.now() - started;
  if (outcome === "timeout") expect(elapsed).toBeLessThan(2000);
  else expect(["other"]).toContain(outcome);
});

// --- 2. Events from private projects ---

test.concurrent("by default an endpoint gets no events from a private project; the public project still gets its events", async () => withRollback(db, async (tx) => {
  const s = await setup(tx);
  const hooks = createOutboundWebhookActions(tx, { allowPrivateNetworks: true });
  const created = await hooks.createOutboundWebhook.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id, name: "Default", url: "https://93.184.216.34/hook", events: ["work_item.created"] });
  expect(created.includePrivateProjects).toBe(false);
  await s.item(s.secret.id, "Private work");
  expect(await s.deliveriesOf(created.id)).toHaveLength(0);
  await s.item(s.app.id, "Public work");
  expect(await s.deliveriesOf(created.id)).toHaveLength(1);
}));

test.concurrent("an endpoint that opts in gets its private project's events while its creator can see the project", async () => withRollback(db, async (tx) => {
  const s = await setup(tx);
  const hooks = createOutboundWebhookActions(tx, { allowPrivateNetworks: true });
  const created = await hooks.createOutboundWebhook.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id, name: "Opt-in", url: "https://93.184.216.34/hook", events: ["work_item.created"], includePrivateProjects: true });
  await s.item(s.secret.id, "Private work");
  const rows = await s.deliveriesOf(created.id);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.projectId).toBe(s.secret.id);
  // Turning the opt-in off stops the next event; a queued one is refused at send time.
  await hooks.updateOutboundWebhook.handler({ userId: s.admin.id }, { webhookId: created.id, includePrivateProjects: false });
  const sent = spyTransport();
  expect(await deliverOutboundWebhook(tx, rows[0]!.id, { allowPrivateNetworks: true, transport: sent.transport })).toBe("failed");
  expect(sent.calls).toHaveLength(0);
}));

test.concurrent("an endpoint whose creator was demoted from Admin gets no events, and a queued one is refused", async () => withRollback(db, async (tx) => {
  const s = await setup(tx);
  const owner = await createMemberFactory(tx, s.workspace.id, "Admin");
  const hooks = createOutboundWebhookActions(tx, { allowPrivateNetworks: true });
  const created = await hooks.createOutboundWebhook.handler({ userId: owner.id }, { workspaceId: s.workspace.id, name: "Owner's", url: "https://93.184.216.34/hook", events: ["work_item.created"], includePrivateProjects: true });
  await s.item(s.app.id, "Queued before demotion");
  const [queued] = await s.deliveriesOf(created.id);
  await createMemberActions(tx).changeMemberRole.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id, userId: owner.id, role: "Member" });
  await s.item(s.app.id, "After demotion");
  await s.item(s.secret.id, "Private after demotion");
  expect(await s.deliveriesOf(created.id)).toHaveLength(1);
  const sent = spyTransport();
  expect(await deliverOutboundWebhook(tx, queued!.id, { allowPrivateNetworks: true, transport: sent.transport })).toBe("failed");
  expect(sent.calls).toHaveLength(0);
  const [row] = await tx.select().from(outboundWebhookDeliveries).where(eq(outboundWebhookDeliveries.id, queued!.id));
  expect(row!.lastError).toContain("no longer an admin");
}));

// --- 3. run.finished on cancelled Runs; revoked and disabled endpoints ---

async function runFixture(tx: Database, s: Awaited<ReturnType<typeof setup>>) {
  const agentActions = createAgentActions(tx);
  const agent = await agentActions.createAgent.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id, name: "Runner", model: "default", monthlyTokenBudget: null });
  await agentActions.setAgentProjectAccess.handler({ userId: s.admin.id }, { agentId: agent.id, allProjects: true, projectIds: [] });
  const [token] = await tx.insert(apiTokens).values({ userId: s.member.id, name: "Daemon", tokenHash: randomUUID(), tokenPrefix: "weft_daemon", daemonOnly: true, expiresAt: new Date(Date.now() + 86_400_000) }).returning();
  const [daemon] = await tx.insert(daemons).values({ ownerId: s.member.id, tokenId: token!.id, hostname: "laptop", version: "1.0.0" }).returning();
  const [runtime] = await tx.insert(runtimes).values({ workspaceId: s.workspace.id, daemonId: daemon!.id, ownerId: s.member.id, agentCli: "claude", shared: true, lastSeenAt: new Date() }).returning();
  await tx.update(agents).set({ runtimeId: runtime!.id, cliModel: null }).where(eq(agents.id, agent.id));
  const item = await createWorkItemActions(tx).createWorkItem.handler({ userId: s.member.id }, { projectId: s.app.id, title: "Cancel me" });
  await createWorkItemActions(tx).updateWorkItem.handler({ userId: s.member.id }, { workItemId: item.id, assigneeIds: [agent.userId] });
  const [run] = await tx.select().from(runs).where(eq(runs.workItemId, item.id));
  return { agent, run: run! };
}

test.concurrent("a cancelled Run is delivered as run.finished with status cancelled", async () => withRollback(db, async (tx) => {
  const s = await setup(tx);
  const hooks = createOutboundWebhookActions(tx, { allowPrivateNetworks: true });
  const created = await hooks.createOutboundWebhook.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id, name: "Runs", url: "https://93.184.216.34/hook", events: ["run.finished"] });
  const { run } = await runFixture(tx, s);
  await createRunActions(tx).cancelRun.handler({ userId: s.member.id }, { runId: run.id });
  const [delivery] = await s.deliveriesOf(created.id);
  expect(delivery!.eventType).toBe("run.finished");
  const sent = spyTransport();
  expect(await deliverOutboundWebhook(tx, delivery!.id, { allowPrivateNetworks: true, transport: sent.transport })).toBe("succeeded");
  const body = JSON.parse(JSON.stringify(delivery!.payload)) as { data: { run: { id: string; status: string } } };
  expect(body.data.run).toMatchObject({ id: run.id, status: "cancelled" });
}));

test.concurrent("a disabled endpoint sends nothing, including deliveries already queued for a retry", async () => withRollback(db, async (tx) => {
  const s = await setup(tx);
  const hooks = createOutboundWebhookActions(tx, { allowPrivateNetworks: true });
  const created = await hooks.createOutboundWebhook.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id, name: "Paused", url: "https://93.184.216.34/hook", events: ["work_item.created"] });
  await s.item(s.app.id, "Queued");
  await hooks.updateOutboundWebhook.handler({ userId: s.admin.id }, { webhookId: created.id, enabled: false });
  await s.item(s.app.id, "While disabled");
  expect(await s.deliveriesOf(created.id)).toHaveLength(1);
  const [queued] = await s.deliveriesOf(created.id);
  const sent = spyTransport();
  expect(await deliverOutboundWebhook(tx, queued!.id, { allowPrivateNetworks: true, transport: sent.transport })).toBe("failed");
  expect(sent.calls).toHaveLength(0);
}));

test.concurrent("a deleted endpoint and its secret send nothing: queued deliveries are gone and new events are not recorded", async () => withRollback(db, async (tx) => {
  const s = await setup(tx);
  const hooks = createOutboundWebhookActions(tx, { allowPrivateNetworks: true });
  const created = await hooks.createOutboundWebhook.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id, name: "Gone", url: "https://93.184.216.34/hook", events: ["work_item.created"] });
  await s.item(s.app.id, "Queued before delete");
  const [queued] = await s.deliveriesOf(created.id);
  await hooks.deleteOutboundWebhook.handler({ userId: s.admin.id }, { webhookId: created.id });
  await s.item(s.app.id, "After delete");
  expect(await tx.select().from(outboundWebhooks).where(eq(outboundWebhooks.id, created.id))).toHaveLength(0);
  expect(await tx.select().from(outboundWebhookDeliveries).where(eq(outboundWebhookDeliveries.id, queued!.id))).toHaveLength(0);
  const sent = spyTransport();
  expect(await deliverOutboundWebhook(tx, queued!.id, { allowPrivateNetworks: true, transport: sent.transport })).toBe("missing");
  expect(sent.calls).toHaveLength(0);
}));

test.concurrent("after a secret rotation a queued delivery is signed only with the new secret", async () => withRollback(db, async (tx) => {
  const s = await setup(tx);
  const hooks = createOutboundWebhookActions(tx, { allowPrivateNetworks: true });
  const created = await hooks.createOutboundWebhook.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id, name: "Rotated", url: "https://93.184.216.34/hook", events: ["work_item.created"] });
  await s.item(s.app.id, "Queued before rotation");
  const [queued] = await s.deliveriesOf(created.id);
  const rotated = await hooks.rotateOutboundWebhookSecret.handler({ userId: s.admin.id }, { webhookId: created.id });
  const sent = spyTransport();
  expect(await deliverOutboundWebhook(tx, queued!.id, { allowPrivateNetworks: true, transport: sent.transport })).toBe("succeeded");
  const request = sent.calls[0]!;
  const expected = (secret: string) => `sha256=${createHmac("sha256", secret).update(`${request.headers["x-weft-timestamp"]}.${request.body}`).digest("hex")}`;
  expect(request.headers["x-weft-signature"]).toBe(expected(rotated.secret));
  expect(request.headers["x-weft-signature"]).not.toBe(expected(created.secret));
  const [row] = await tx.select().from(outboundWebhooks).where(eq(outboundWebhooks.id, created.id));
  expect(openSecret(row!.secretSealed)).toBe(rotated.secret);
  expect(signOutboundBody(created.secret, 1, "{}")).not.toBe(signOutboundBody(rotated.secret, 1, "{}"));
}));

