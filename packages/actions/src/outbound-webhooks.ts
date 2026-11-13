import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { Type, type TSchema } from "@sinclair/typebox";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import type { Database } from "@weft/db";
import { outboundWebhookDeliveries, outboundWebhooks, projects, runs, users, workItemStates, workItemTypes, workItems } from "@weft/db";
import { ActionError, requireWorkspaceRole } from "./members";
import { auditAgentChange } from "./agent-audit";
import { openSecret, sealSecret } from "./integration-secrets";
import { enqueueJob } from "./jobs";
import { loadProperties, loadPropertyValues, type PropertyDef } from "./work-item-properties";
import { outboundWebhooksAllowPrivateNetworks, outboundWebhooksEnabled } from "./outbound-webhooks-flag";
import { checkWebhookUrl, resolveWebhookTarget, TransientWebhookLookupError, type AddressLookup } from "./outbound-webhook-network";
import { pinnedTransport, type WebhookTransport } from "./outbound-webhook-transport";
import { requireProjectAccess } from "./projects";

/** Events a webhook can subscribe to. A test send uses its own type, webhook.test, which no subscription needs. */
export const outboundEventTypes = ["work_item.created", "work_item.updated", "comment.created", "run.finished"] as const;
export type OutboundEventType = (typeof outboundEventTypes)[number];
/** Every Action this feature adds; registered only while WEFT_OUTBOUND_WEBHOOKS_ENABLED is true. */
export const outboundWebhookActionNames = [
  "list_outbound_webhooks", "get_outbound_webhook_url", "create_outbound_webhook", "update_outbound_webhook", "rotate_outbound_webhook_secret", "delete_outbound_webhook",
  "test_outbound_webhook", "list_outbound_webhook_deliveries", "redeliver_outbound_webhook_delivery",
] as const;
export const outboundJobType = "outbound_webhook_delivery";
/** One first attempt plus five retries. */
export const outboundMaxAttempts = 6;
/** Wait before retry 1, 2, 3, 4 and 5. */
export const outboundRetryBackoffMs = [60_000, 300_000, 1_800_000, 7_200_000, 43_200_000];
const sendTimeoutMs = 10_000;
/** The delivery log keeps this many days; the cleanup job deletes older finished deliveries. */
export const outboundDeliveryRetentionDays = 30;
/** A webhook is turned off after this many deliveries in a row that ended failed; an Admin turns it back on. */
export const outboundDisableAfterFailures = 10;
/** The disabledReason a webhook carries when it was turned off by failures. */
export const outboundDisabledByFailures = "failures";
const maxExcerptBytes = 4096;
const maxWebhooksPerWorkspace = 20;
const maxExcerptChars = 500;

export type OutboundDeliveryOptions = {
  /** Sends one POST to the address resolveWebhookTarget validated. Tests replace it to see what would be sent. */
  transport?: WebhookTransport;
  lookup?: AddressLookup;
  allowPrivateNetworks?: boolean;
  now?: () => Date;
  /** A test send gives up after one attempt, so the Admin sees the answer at once. */
  maxAttempts?: number;
  /** Test seam for proving retry state and its scheduled job commit together. */
  enqueue?: typeof enqueueJob;
};

const uuid = () => Type.String({ format: "uuid" });
const nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
const eventField = Type.Union(outboundEventTypes.map((value) => Type.Literal(value)));
const webhookOutput = Type.Object({
  id: Type.String(), name: Type.String(), displayUrl: Type.String(), events: Type.Array(Type.String()), enabled: Type.Boolean(),
  /** "failures" when the webhook was turned off because deliveries kept failing; null otherwise. */
  disabledReason: nullable(Type.String()),
  includePrivateProjects: Type.Boolean(), createdAt: Type.String(),
});
const deliveryOutput = Type.Object({
  id: Type.String(), webhookId: Type.String(), eventId: Type.String(), eventType: Type.String(), status: Type.String(), attempts: Type.Integer(),
  responseStatus: nullable(Type.Integer()), responseExcerpt: nullable(Type.String()), lastError: nullable(Type.String()),
  createdAt: Type.String(), lastAttemptAt: nullable(Type.String()), nextAttemptAt: nullable(Type.String()), deliveredAt: nullable(Type.String()),
});

type WebhookRow = typeof outboundWebhooks.$inferSelect;
type DeliveryRow = typeof outboundWebhookDeliveries.$inferSelect;

/** The address with its path and query hidden: scheme and host stay, because paths often carry a token. Used in lists and the audit log. */
export function maskWebhookUrl(raw: string) {
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}/…`;
  } catch {
    return "…";
  }
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The signature receivers check: HMAC-SHA256 over "<unix seconds>.<raw body>", sent as X-Weft-Signature: sha256=<hex>. */
export function signOutboundBody(secret: string, timestamp: number, body: string) {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

/** A work item as receivers see it: key, title, state, type and custom property values by label, never raw ids. */
export async function workItemSnapshot(database: Database, workItemId: string) {
  const [item] = await database.select().from(workItems).where(eq(workItems.id, workItemId));
  if (!item) return null;
  const [project] = await database.select().from(projects).where(eq(projects.id, item.projectId));
  const [state] = await database.select({ name: workItemStates.name, group: workItemStates.group }).from(workItemStates).where(eq(workItemStates.id, item.stateId));
  const [type] = item.typeId ? await database.select({ name: workItemTypes.name }).from(workItemTypes).where(eq(workItemTypes.id, item.typeId)) : [];
  const definitions: PropertyDef[] = await loadProperties(database, item.projectId, item.typeId ?? undefined);
  const values = (await loadPropertyValues(database, [item.id])).get(item.id) ?? [];
  const memberIds = [...new Set(values.flatMap((entry) => {
    const definition = definitions.find((candidate) => candidate.id === entry.propertyId);
    if (definition?.kind !== "person") return [];
    return (Array.isArray(entry.value) ? entry.value : [entry.value]).filter((value): value is string => typeof value === "string");
  }))];
  const names = new Map(memberIds.length ? (await database.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, memberIds))).map((row) => [row.id, row.name]) : []);
  const properties = values.flatMap((entry) => {
    const definition = definitions.find((candidate) => candidate.id === entry.propertyId);
    if (!definition) return [];
    const labelOf = (optionId: unknown) => definition.options.find((option) => option.id === optionId)?.label ?? null;
    let value: unknown = entry.value;
    if (definition.kind === "dropdown") value = labelOf(entry.value);
    if (definition.kind === "multi_select") value = (Array.isArray(entry.value) ? entry.value : []).map(labelOf).filter((label) => label !== null);
    if (definition.kind === "person") value = (Array.isArray(entry.value) ? entry.value : [entry.value]).map((id) => names.get(String(id))).filter((name) => name !== undefined);
    return [{ label: definition.name, kind: definition.kind, value }];
  });
  return {
    id: item.id, key: `${project?.key ?? ""}-${item.sequence}`, projectId: item.projectId, title: item.title, priority: item.priority,
    state: state ? { name: state.name, group: state.group } : null, type: type?.name ?? null, startDate: item.startDate, dueDate: item.dueDate, properties,
  };
}

/** Answers of one emit, so a creator's role and project access are looked up once however many webhooks they own. */
export type AccessCache = { admin: Map<string, Promise<boolean>>; project: Map<string, Promise<boolean>> };
export const newAccessCache = (): AccessCache => ({ admin: new Map(), project: new Map() });
const remembered = (map: Map<string, Promise<boolean>>, key: string, load: () => Promise<boolean>) => {
  let found = map.get(key);
  if (!found) { found = load(); map.set(key, found); }
  return found;
};

/** True while the webhook's creator is still a workspace Admin. Losing that role revokes the webhook's sending. */
export async function creatorMayManage(database: Database, webhook: { createdBy: string; workspaceId: string }, cache?: AccessCache) {
  const load = async () => {
    try {
      await requireWorkspaceRole(database, webhook.createdBy, webhook.workspaceId, "admin");
      return true;
    } catch {
      return false;
    }
  };
  return cache ? remembered(cache.admin, `${webhook.createdBy}:${webhook.workspaceId}`, load) : load();
}

/**
 * A webhook receives an event of a project only when the webhook's creator is still an Admin and can see the project.
 * Private projects are never sent unless the endpoint opted in, so the default is no private-project events at all.
 */
export async function mayReceiveProject(database: Database, webhook: WebhookRow, project: { id: string; visibility: string }, cache?: AccessCache) {
  if (project.visibility !== "public" && !webhook.includePrivateProjects) return false;
  if (!(await creatorMayManage(database, webhook, cache))) return false;
  const load = async () => {
    try {
      await requireProjectAccess(database, webhook.createdBy, project.id, "read");
      return true;
    } catch {
      return false;
    }
  };
  return cache ? remembered(cache.project, `${webhook.createdBy}:${project.id}`, load) : load();
}

/**
 * Records one event for every enabled webhook of the workspace that subscribes to it, and queues one delivery job each.
 * Runs inside the caller's transaction, so an event is recorded only when the change it describes is saved. Does nothing
 * with the flag off, and builds the payload only when a webhook wants the event.
 */
export async function emitOutboundEvent(database: Database, input: { workspaceId: string; type: OutboundEventType; projectId?: string | null; build: (database: Database) => Promise<Record<string, unknown>> }, options: { required?: boolean } = {}) {
  if (!outboundWebhooksEnabled()) return;
  // Keep every query, payload build and insert in a savepoint. PostgreSQL errors abort the
  // current transaction until rollback, so catching alone would poison the caller's write.
  try {
    await database.transaction(async (savepoint) => {
      const scoped = savepoint as unknown as Database;
      const hooks = (await scoped.select().from(outboundWebhooks).where(and(eq(outboundWebhooks.workspaceId, input.workspaceId), eq(outboundWebhooks.enabled, true)))).filter((hook) => hook.events.includes(input.type));
      if (hooks.length === 0) return;
      const project = input.projectId ? (await scoped.select().from(projects).where(eq(projects.id, input.projectId)))[0] ?? null : null;
      const cache = newAccessCache();
      const subscribed = [];
      for (const hook of hooks) {
        // A failed check must not break the write that caused the event; the hook just does not get this one.
        const allowed = !project || await mayReceiveProject(scoped, hook, project, cache).catch(() => false);
        if (allowed) subscribed.push(hook);
      }
      if (subscribed.length === 0) return;
      const eventId = randomUUID();
      const envelope = { id: eventId, type: input.type, createdAt: new Date().toISOString(), workspaceId: input.workspaceId };
      let body: Record<string, unknown> | null = null;
      let buildError: string | null = null;
      try {
        body = { ...envelope, data: await input.build(scoped) };
      } catch (error) {
        buildError = `The event could not be prepared: ${messageOf(error)}`;
      }
      for (const hook of subscribed) {
        try {
          // A savepoint: if one hook's rows cannot be written, only that hook is skipped and the caller's transaction stays usable.
          await scoped.transaction(async (savepoint) => {
            const scoped = savepoint as unknown as Database;
            const values = { webhookId: hook.id, workspaceId: input.workspaceId, eventId, eventType: input.type, projectId: project?.id ?? null };
            if (body === null) {
              await scoped.insert(outboundWebhookDeliveries).values({ ...values, payload: envelope, status: "failed", lastError: buildError, lastAttemptAt: new Date() }).onConflictDoNothing();
              return;
            }
            const [row] = await scoped.insert(outboundWebhookDeliveries).values({ ...values, payload: body }).onConflictDoNothing().returning({ id: outboundWebhookDeliveries.id });
            if (row) await enqueueJob(scoped, { type: outboundJobType, payload: { deliveryId: row.id }, dedupeKey: `${outboundJobType}:${row.id}` });
          });
        } catch (error) {
          if (options.required) throw error;
          // Mark it failed in its own savepoint; if even that fails the event is dropped for this hook, never thrown into the write.
          await scoped.transaction(async (savepoint) => {
            await (savepoint as unknown as Database).insert(outboundWebhookDeliveries).values({
              webhookId: hook.id, workspaceId: input.workspaceId, eventId, eventType: input.type, projectId: project?.id ?? null,
              payload: envelope, status: "failed", lastError: `The event could not be queued: ${messageOf(error)}`, lastAttemptAt: new Date(),
            }).onConflictDoNothing();
          }).catch(() => undefined);
        }
      }
    });
  } catch (error) {
    // Roll back the savepoint before swallowing a failure so the caller's transaction stays usable.
    if (options.required) throw error;
  }
}

/** Records run.finished for a Run that just reached a final status. */
export async function emitRunFinished(database: Database, runId: string) {
  if (!outboundWebhooksEnabled()) return;
  const [run] = await database.select().from(runs).where(eq(runs.id, runId));
  if (!run) return;
  await emitOutboundEvent(database, {
    workspaceId: run.workspaceId, projectId: run.projectId, type: "run.finished",
    build: async (database) => ({
      run: { id: run.id, status: run.status, failureReason: run.failureReason, projectId: run.projectId, workItemId: run.workItemId, finishedAt: run.finishedAt?.toISOString() ?? null },
      workItem: run.workItemId ? await workItemSnapshot(database, run.workItemId) : null,
    }),
  }, { required: true });
}

async function readExcerpt(response: Response): Promise<string | null> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < maxExcerptBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
    }
  } catch { /* a receiver that cuts the body short still counts as answered */ } finally {
    await reader.cancel().catch(() => undefined);
  }
  return new TextDecoder().decode(Buffer.concat(chunks)).slice(0, maxExcerptChars);
}

type Attempt = { ok: boolean; permanent: boolean; responseStatus: number | null; excerpt: string | null; error: string | null };

async function sendOnce(webhook: WebhookRow, delivery: DeliveryRow, now: Date, options: OutboundDeliveryOptions): Promise<Attempt> {
  const refused = (error: string): Attempt => ({ ok: false, permanent: true, responseStatus: null, excerpt: null, error });
  let target;
  try {
    // Resolved now, at send time, and pinned: the connection uses the address validated here, never a second lookup.
    target = await resolveWebhookTarget(webhook.url, { allowPrivate: options.allowPrivateNetworks ?? outboundWebhooksAllowPrivateNetworks(), lookup: options.lookup });
  } catch (error) {
    return { ...refused(messageOf(error)), permanent: !(error instanceof TransientWebhookLookupError) };
  }
  const body = JSON.stringify(delivery.payload);
  const timestamp = Math.floor(now.getTime() / 1000);
  const signature = signOutboundBody(openSecret(webhook.secretSealed), timestamp, body);
  try {
    const response = await (options.transport ?? pinnedTransport)({
      target, timeoutMs: sendTimeoutMs, body,
      headers: {
        "content-type": "application/json", "user-agent": "Weft-Webhooks", "x-weft-event": delivery.eventType, "x-weft-delivery": delivery.eventId,
        "x-weft-timestamp": String(timestamp), "x-weft-signature": signature,
      },
    });
    const status = response.status;
    if (status >= 200 && status < 300) return { ok: true, permanent: false, responseStatus: status, excerpt: response.excerpt, error: null };
    if (status >= 300 && status < 400) return { ok: false, permanent: true, responseStatus: status, excerpt: response.excerpt, error: `The receiver redirected (status ${status}). Redirects are not followed; use the final address.` };
    return { ok: false, permanent: false, responseStatus: status, excerpt: response.excerpt, error: `The receiver answered with status ${status}` };
  } catch (error) {
    // A connect failure, a refused port and a connect timeout all read the same, so the message never tells a closed port from a filtered one.
    const connected = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError") && error.message !== "connect timed out";
    return { ok: false, permanent: false, responseStatus: null, excerpt: null, error: connected ? "The receiver did not answer within 10 seconds" : "The receiver could not be reached" };
  }
}

/**
 * Sends one delivery now. Success ends it. A failure with attempts left is scheduled with backoff, and the same job id
 * carries on; a refused address or a redirect fails at once. The event id and body never change between attempts.
 */
export async function deliverOutboundWebhook(database: Database, deliveryId: string, options: OutboundDeliveryOptions = {}): Promise<"succeeded" | "retrying" | "failed" | "missing"> {
  const [row] = await database.select({ delivery: outboundWebhookDeliveries, webhook: outboundWebhooks }).from(outboundWebhookDeliveries)
    .innerJoin(outboundWebhooks, eq(outboundWebhooks.id, outboundWebhookDeliveries.webhookId)).where(eq(outboundWebhookDeliveries.id, deliveryId));
  if (!row) return "missing";
  const { delivery, webhook } = row;
  if (delivery.status === "succeeded") return "succeeded";
  const now = (options.now ?? (() => new Date()))();
  const attempts = delivery.attempts + 1;
  const revoked = await revocationOf(database, webhook, delivery);
  const outcome = revoked ?? await sendOnce(webhook, delivery, now, options);
  const limit = options.maxAttempts ?? outboundMaxAttempts;
  const base = { attempts, lastAttemptAt: now, responseStatus: outcome.responseStatus, responseExcerpt: outcome.excerpt, lastError: outcome.error };
  if (outcome.ok) {
    await database.update(outboundWebhookDeliveries).set({ ...base, lastError: null, status: "succeeded", nextAttemptAt: null, deliveredAt: now }).where(eq(outboundWebhookDeliveries.id, delivery.id));
    if (webhook.consecutiveFailures > 0) await database.update(outboundWebhooks).set({ consecutiveFailures: 0 }).where(eq(outboundWebhooks.id, webhook.id));
    return "succeeded";
  }
  if (outcome.permanent || attempts >= limit) {
    await database.update(outboundWebhookDeliveries).set({ ...base, status: "failed", nextAttemptAt: null }).where(eq(outboundWebhookDeliveries.id, delivery.id));
    // A revoked send and a test send say nothing about the receiver's health, so only real sends count toward turning the webhook off.
    if (!revoked && delivery.eventType !== "webhook.test") await countFailure(database, webhook);
    return "failed";
  }
  const runAt = new Date(now.getTime() + outboundRetryBackoffMs[Math.min(attempts - 1, outboundRetryBackoffMs.length - 1)]!);
  await database.transaction(async (transaction) => {
    const tx = transaction as unknown as Database;
    await tx.update(outboundWebhookDeliveries).set({ ...base, status: "retrying", nextAttemptAt: runAt }).where(eq(outboundWebhookDeliveries.id, delivery.id));
    await (options.enqueue ?? enqueueJob)(tx, { type: outboundJobType, payload: { deliveryId: delivery.id }, runAt, dedupeKey: `${outboundJobType}:${delivery.id}:${attempts}` });
  });
  return "retrying";
}

/** Adds one failed delivery to the webhook's streak, and turns the webhook off when the streak reaches the limit. */
async function countFailure(database: Database, webhook: WebhookRow) {
  const [row] = await database.update(outboundWebhooks).set({ consecutiveFailures: sql`${outboundWebhooks.consecutiveFailures} + 1` }).where(eq(outboundWebhooks.id, webhook.id)).returning({ failures: outboundWebhooks.consecutiveFailures });
  if (!row || row.failures < outboundDisableAfterFailures) return;
  const [turnedOff] = await database.update(outboundWebhooks).set({ enabled: false, disabledReason: outboundDisabledByFailures, updatedAt: new Date() })
    .where(and(eq(outboundWebhooks.id, webhook.id), eq(outboundWebhooks.enabled, true))).returning({ id: outboundWebhooks.id });
  if (turnedOff) await auditAgentChange(database, { workspaceId: webhook.workspaceId, entityType: "workspace", entityId: webhook.workspaceId, field: "outbound_webhook.auto_disabled", oldValue: true, newValue: false, actorId: webhook.createdBy });
}

/**
 * Reasons a queued delivery must not be sent any more, checked at send time: the webhook was turned off, its creator is
 * no longer an Admin, or its project is no longer one the endpoint may receive. Returns null when it may be sent.
 */
async function revocationOf(database: Database, webhook: WebhookRow, delivery: DeliveryRow): Promise<Attempt | null> {
  const stop = (error: string): Attempt => ({ ok: false, permanent: true, responseStatus: null, excerpt: null, error });
  if (!webhook.enabled) return stop("The webhook is turned off, so nothing was sent");
  if (!(await creatorMayManage(database, webhook))) return stop("The admin who set up this webhook is no longer an admin, so nothing was sent");
  if (delivery.projectId) {
    const [project] = await database.select().from(projects).where(eq(projects.id, delivery.projectId));
    if (!project || !(await mayReceiveProject(database, webhook, project))) return stop("This event is from a project this webhook may not receive, so nothing was sent");
  }
  return null;
}

/** The `cleanup_outbound_webhook_deliveries` job: deletes finished deliveries older than the retention window. Safe to run twice. */
export async function purgeOutboundDeliveries(database: Database, now: Date = new Date()) {
  const cutoff = new Date(now.getTime() - outboundDeliveryRetentionDays * 86_400_000);
  const removed = await database.delete(outboundWebhookDeliveries).where(and(lt(outboundWebhookDeliveries.createdAt, cutoff), inArray(outboundWebhookDeliveries.status, ["succeeded", "failed"]))).returning({ id: outboundWebhookDeliveries.id });
  return removed.length;
}

/** The job handler the worker registers only while the flag is on. */
export function outboundDeliveryJobHandler(options: OutboundDeliveryOptions = {}) {
  return async (database: Database, payload: unknown) => {
    await deliverOutboundWebhook(database, (payload as { deliveryId: string }).deliveryId, options);
  };
}

const summarise = (row: WebhookRow) => ({ id: row.id, name: row.name, displayUrl: maskWebhookUrl(row.url), disabledReason: row.disabledReason, events: row.events, enabled: row.enabled, includePrivateProjects: row.includePrivateProjects, createdAt: row.createdAt.toISOString() });
const summariseDelivery = (row: DeliveryRow) => ({
  id: row.id, webhookId: row.webhookId, eventId: row.eventId, eventType: row.eventType, status: row.status, attempts: row.attempts,
  responseStatus: row.responseStatus, responseExcerpt: row.responseExcerpt, lastError: row.lastError, createdAt: row.createdAt.toISOString(),
  lastAttemptAt: row.lastAttemptAt?.toISOString() ?? null, nextAttemptAt: row.nextAttemptAt?.toISOString() ?? null, deliveredAt: row.deliveredAt?.toISOString() ?? null,
});

export function createOutboundWebhookActions(db: Database, options: OutboundDeliveryOptions = {}) {
  const sendOptions = (): OutboundDeliveryOptions => ({ transport: options.transport, lookup: options.lookup, now: options.now, allowPrivateNetworks: options.allowPrivateNetworks });

  async function webhookOf(webhookId: string) {
    const [row] = await db.select().from(outboundWebhooks).where(eq(outboundWebhooks.id, webhookId));
    if (!row) throw new ActionError("Webhook not found", 404);
    return row;
  }
  async function workspaceAdmin(userId: string, workspaceId: string) {
    await requireWorkspaceRole(db, userId, workspaceId, "admin");
  }
  const name = (value: string) => {
    const trimmed = value.trim();
    if (trimmed.length === 0) throw new ActionError("Give the webhook a name", 400);
    return trimmed;
  };
  const urlOf = (value: string) => checkWebhookUrl(value, { allowPrivate: options.allowPrivateNetworks ?? outboundWebhooksAllowPrivateNetworks(), lookup: options.lookup });
  const eventsOf = (events: string[]) => {
    const unique = [...new Set(events)];
    if (unique.length === 0) throw new ActionError("Choose at least one event for the webhook to receive", 400);
    return unique;
  };

  return {
    listOutboundWebhooks: {
      name: "list_outbound_webhooks", kind: "read" as const, input: Type.Object({ workspaceId: uuid() }), output: Type.Array(webhookOutput),
      handler: async (context: { userId: string }, input: { workspaceId: string }) => {
        await workspaceAdmin(context.userId, input.workspaceId);
        const rows = await db.select().from(outboundWebhooks).where(eq(outboundWebhooks.workspaceId, input.workspaceId)).orderBy(outboundWebhooks.createdAt);
        return rows.map(summarise);
      },
    },
    getOutboundWebhookUrl: {
      name: "get_outbound_webhook_url", kind: "read" as const,
      input: Type.Object({ webhookId: uuid() }), output: Type.Object({ url: Type.String() }),
      handler: async (context: { userId: string }, input: { webhookId: string }) => {
        const row = await webhookOf(input.webhookId);
        await workspaceAdmin(context.userId, row.workspaceId);
        await auditAgentChange(db, { workspaceId: row.workspaceId, entityType: "workspace", entityId: row.workspaceId, field: "outbound_webhook.url_viewed", oldValue: null, newValue: row.id, actorId: context.userId });
        return { url: row.url };
      },
    },
    createOutboundWebhook: {
      name: "create_outbound_webhook", kind: "write" as const,
      input: Type.Object({ workspaceId: uuid(), name: Type.String({ minLength: 1, maxLength: 100 }), url: Type.String({ maxLength: 2000 }), events: Type.Array(eventField, { minItems: 1, maxItems: outboundEventTypes.length }), includePrivateProjects: Type.Optional(Type.Boolean()) }),
      output: Type.Intersect([webhookOutput, Type.Object({ secret: Type.String() })]),
      handler: async (context: { userId: string }, input: { workspaceId: string; name: string; url: string; events: OutboundEventType[]; includePrivateProjects?: boolean }) => {
        await workspaceAdmin(context.userId, input.workspaceId);
        const url = await urlOf(input.url);
        const events = eventsOf(input.events);
        const existing = await db.select({ id: outboundWebhooks.id }).from(outboundWebhooks).where(eq(outboundWebhooks.workspaceId, input.workspaceId));
        if (existing.length >= maxWebhooksPerWorkspace) throw new ActionError(`A workspace can have at most ${maxWebhooksPerWorkspace} webhooks`, 409);
        // The secret is returned once, here; later reads only see that it exists.
        const secret = randomBytes(32).toString("hex");
        const [row] = await db.insert(outboundWebhooks).values({ workspaceId: input.workspaceId, name: name(input.name), url, events, includePrivateProjects: input.includePrivateProjects === true, secretSealed: sealSecret(secret), createdBy: context.userId }).returning();
        await auditAgentChange(db, { workspaceId: input.workspaceId, entityType: "workspace", entityId: input.workspaceId, field: "outbound_webhook.created", oldValue: null, newValue: row!.id, actorId: context.userId });
        return { ...summarise(row!), secret };
      },
    },
    updateOutboundWebhook: {
      name: "update_outbound_webhook", kind: "write" as const,
      input: Type.Object({ webhookId: uuid(), name: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })), url: Type.Optional(Type.String({ maxLength: 2000 })), events: Type.Optional(Type.Array(eventField, { minItems: 1, maxItems: outboundEventTypes.length })), enabled: Type.Optional(Type.Boolean()), includePrivateProjects: Type.Optional(Type.Boolean()) }),
      output: webhookOutput,
      handler: async (context: { userId: string }, input: { webhookId: string; name?: string; url?: string; events?: OutboundEventType[]; enabled?: boolean; includePrivateProjects?: boolean }) => {
        const before = await webhookOf(input.webhookId);
        await workspaceAdmin(context.userId, before.workspaceId);
        const patch: Partial<typeof outboundWebhooks.$inferInsert> = { updatedAt: new Date() };
        if (input.name !== undefined) patch.name = name(input.name);
        if (input.url !== undefined) patch.url = await urlOf(input.url);
        if (input.events !== undefined) patch.events = eventsOf(input.events);
        if (input.enabled !== undefined) {
          patch.enabled = input.enabled;
          // Turning it on or off by hand clears the "turned off by failures" state and the failure streak.
          patch.disabledReason = null;
          if (input.enabled) patch.consecutiveFailures = 0;
        }
        if (input.includePrivateProjects !== undefined) patch.includePrivateProjects = input.includePrivateProjects;
        const [row] = await db.update(outboundWebhooks).set(patch).where(eq(outboundWebhooks.id, before.id)).returning();
        if (input.includePrivateProjects !== undefined && input.includePrivateProjects !== before.includePrivateProjects) await auditAgentChange(db, { workspaceId: before.workspaceId, entityType: "workspace", entityId: before.workspaceId, field: "outbound_webhook.include_private_projects", oldValue: before.includePrivateProjects, newValue: input.includePrivateProjects, actorId: context.userId });
        if (input.enabled !== undefined && input.enabled !== before.enabled) await auditAgentChange(db, { workspaceId: before.workspaceId, entityType: "workspace", entityId: before.workspaceId, field: "outbound_webhook.enabled", oldValue: before.enabled, newValue: input.enabled, actorId: context.userId });
        if (input.url !== undefined && patch.url !== before.url) await auditAgentChange(db, { workspaceId: before.workspaceId, entityType: "workspace", entityId: before.workspaceId, field: "outbound_webhook.url", oldValue: maskWebhookUrl(before.url), newValue: maskWebhookUrl(patch.url!), actorId: context.userId });
        return summarise(row!);
      },
    },
    rotateOutboundWebhookSecret: {
      name: "rotate_outbound_webhook_secret", kind: "write" as const,
      input: Type.Object({ webhookId: uuid() }), output: Type.Object({ secret: Type.String() }),
      handler: async (context: { userId: string }, input: { webhookId: string }) => {
        const row = await webhookOf(input.webhookId);
        await workspaceAdmin(context.userId, row.workspaceId);
        const secret = randomBytes(32).toString("hex");
        await db.update(outboundWebhooks).set({ secretSealed: sealSecret(secret), updatedAt: new Date() }).where(eq(outboundWebhooks.id, row.id));
        await auditAgentChange(db, { workspaceId: row.workspaceId, entityType: "workspace", entityId: row.workspaceId, field: "outbound_webhook.secret", oldValue: null, newValue: "rotated", actorId: context.userId });
        return { secret };
      },
    },
    deleteOutboundWebhook: {
      name: "delete_outbound_webhook", kind: "write" as const,
      input: Type.Object({ webhookId: uuid() }), output: Type.Object({ deleted: Type.Boolean() }),
      handler: async (context: { userId: string }, input: { webhookId: string }) => {
        const row = await webhookOf(input.webhookId);
        await workspaceAdmin(context.userId, row.workspaceId);
        await db.delete(outboundWebhooks).where(eq(outboundWebhooks.id, row.id));
        await auditAgentChange(db, { workspaceId: row.workspaceId, entityType: "workspace", entityId: row.workspaceId, field: "outbound_webhook.deleted", oldValue: row.name, newValue: null, actorId: context.userId });
        return { deleted: true };
      },
    },
    testOutboundWebhook: {
      name: "test_outbound_webhook", kind: "write" as const,
      input: Type.Object({ webhookId: uuid() }),
      output: Type.Object({ deliveryId: Type.String(), status: Type.String(), responseStatus: nullable(Type.Integer()), message: Type.String() }),
      handler: async (context: { userId: string }, input: { webhookId: string }) => {
        const row = await webhookOf(input.webhookId);
        await workspaceAdmin(context.userId, row.workspaceId);
        const eventId = randomUUID();
        const payload = { id: eventId, type: "webhook.test", createdAt: new Date().toISOString(), workspaceId: row.workspaceId, data: { message: "This is a test event from Weft." } };
        const [delivery] = await db.insert(outboundWebhookDeliveries).values({ webhookId: row.id, workspaceId: row.workspaceId, eventId, eventType: "webhook.test", payload }).returning();
        const status = await deliverOutboundWebhook(db, delivery!.id, { ...sendOptions(), maxAttempts: 1 });
        const [final] = await db.select().from(outboundWebhookDeliveries).where(eq(outboundWebhookDeliveries.id, delivery!.id));
        const message = status === "succeeded"
          ? `The receiver accepted the test event (status ${final!.responseStatus}).`
          : `The test event was not accepted. ${final?.lastError ?? "Try again."}`;
        return { deliveryId: delivery!.id, status: final!.status, responseStatus: final!.responseStatus, message };
      },
    },
    listOutboundWebhookDeliveries: {
      name: "list_outbound_webhook_deliveries", kind: "read" as const,
      input: Type.Object({ webhookId: uuid(), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }), output: Type.Array(deliveryOutput),
      handler: async (context: { userId: string }, input: { webhookId: string; limit?: number }) => {
        const row = await webhookOf(input.webhookId);
        await workspaceAdmin(context.userId, row.workspaceId);
        const rows = await db.select().from(outboundWebhookDeliveries).where(eq(outboundWebhookDeliveries.webhookId, row.id)).orderBy(desc(outboundWebhookDeliveries.createdAt)).limit(input.limit ?? 50);
        return rows.map(summariseDelivery);
      },
    },
    redeliverOutboundWebhookDelivery: {
      name: "redeliver_outbound_webhook_delivery", kind: "write" as const,
      input: Type.Object({ deliveryId: uuid() }), output: deliveryOutput,
      handler: async (context: { userId: string }, input: { deliveryId: string }) => {
        const [delivery] = await db.select().from(outboundWebhookDeliveries).where(eq(outboundWebhookDeliveries.id, input.deliveryId));
        if (!delivery) throw new ActionError("Delivery not found", 404);
        await workspaceAdmin(context.userId, delivery.workspaceId);
        // A delivery that is still being retried, or already queued by an earlier click, is not queued again.
        if (delivery.status === "retrying") throw new ActionError("This delivery is still being retried. Wait until it succeeds or its last try fails, then redeliver it.", 409);
        if (delivery.status === "pending") return summariseDelivery(delivery);
        // Same event id and payload, so a receiver that already has it can recognise the repeat by X-Weft-Delivery.
        return db.transaction(async (transaction) => {
          const tx = transaction as unknown as Database;
          const [row] = await tx.update(outboundWebhookDeliveries).set({ status: "pending", attempts: 0, nextAttemptAt: null, lastError: null })
            .where(and(eq(outboundWebhookDeliveries.id, delivery.id), inArray(outboundWebhookDeliveries.status, ["succeeded", "failed"]))).returning();
          if (!row) return summariseDelivery((await tx.select().from(outboundWebhookDeliveries).where(eq(outboundWebhookDeliveries.id, delivery.id)))[0]!);
          await (options.enqueue ?? enqueueJob)(tx, { type: outboundJobType, payload: { deliveryId: delivery.id }, dedupeKey: `${outboundJobType}:${delivery.id}:redeliver` });
          return summariseDelivery(row);
        });
      },
    },
  };
}
