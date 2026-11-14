import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Type } from "@sinclair/typebox";
import { and, asc, eq } from "drizzle-orm";
import type { Database } from "@weft/db";
import { projectKeyAliases, projects, workItemIntegrationDeliveries, workItemIntegrationRepositories, workItemIntegrations, workItemPullRequests, workItemStates, workItems } from "@weft/db";
import { ActionError, requireWorkspaceRole } from "./members";
import { requireProjectAccess } from "./projects";
import { unarchivedWorkItems } from "./triage";
import { logActivity, type ActivityContext } from "./work-items";
import { auditAgentChange } from "./agent-audit";
import { openSecret, sealSecret } from "./integration-secrets";

export const integrationProviders = ["github", "gitlab"] as const;
/** Every Action this feature adds; registered only while WEFT_INTEGRATIONS_ENABLED is true. */
export const integrationActionNames = [
  "list_work_item_pull_requests", "list_work_item_integrations", "create_work_item_integration", "update_work_item_integration",
  "rotate_work_item_integration_secret", "get_project_merged_pr_setting", "set_project_merged_pr_setting",
] as const;
export type IntegrationProvider = (typeof integrationProviders)[number];
export type PullRequestState = "open" | "merged" | "closed";
export type ChecksState = "none" | "pending" | "passing" | "failing";

/** Repository paths: GitHub "owner/name", GitLab "group/subgroup/project". */
const repositoryPattern = "^[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)+$";
/** A work item key such as MOB-231, also found inside branch names like feature/mob-231-login. */
const keyPattern = /(?<![A-Za-z0-9])([A-Za-z][A-Za-z0-9]{1,9})-(\d{1,9})(?![A-Za-z0-9])/g;
const maxRepositoriesPerIntegration = 50;

export const webhookPath = (provider: string, integrationId: string) => `/api/webhooks/work-items/${provider}/${integrationId}`;

const uuid = () => Type.String({ format: "uuid" });
const repositoryField = Type.String({ minLength: 3, maxLength: 200, pattern: repositoryPattern });

const integrationOutput = Type.Object({
  id: Type.String(), provider: Type.String(), enabled: Type.Boolean(), repositories: Type.Array(Type.String()),
  webhookPath: Type.String(), createdAt: Type.String(),
});
const pullRequestOutput = Type.Object({
  id: Type.String(), workItemId: Type.String(), provider: Type.String(), repository: Type.String(), number: Type.Integer(),
  title: Type.String(), url: Type.String(), state: Type.String(), checks: Type.String(), updatedAt: Type.String(),
});

type IntegrationRow = typeof workItemIntegrations.$inferSelect;
type PullRequestRow = typeof workItemPullRequests.$inferSelect;
type Incoming = { provider: IntegrationProvider; repository: string; number: number; title: string; url: string; branches: string[]; text: string[]; state: PullRequestState; headSha: string | null; occurredAt: Date | null };
type Check = { repository: string; number: number; headSha: string | null; checks: ChecksState; occurredAt: Date | null };
type WebhookResult = { status: 200 | 400 | 401 | 404; body: Record<string, unknown> };
type Parsed = { kind: "pull_request"; pr: Incoming } | { kind: "checks"; check: Check } | { kind: "ignored"; reason: string } | { kind: "invalid"; reason: string };

/** Lower-cases and trims a repository path so that matching ignores case. */
export function normaliseRepository(value: string) {
  return value.trim().toLowerCase();
}

/** Every work item key (uppercased KEY-n) mentioned in the texts. */
export function workItemKeysIn(texts: string[]) {
  const keys = new Map<string, { key: string; number: number }>();
  for (const text of texts) for (const match of text.matchAll(keyPattern)) {
    const key = match[1]!.toUpperCase();
    const number = Number(match[2]);
    if (number > 0) keys.set(`${key}-${number}`, { key, number });
  }
  return [...keys.values()];
}

/** Hosts a pull request link may point to. GitHub Enterprise and self-hosted GitLab hosts are added with WEFT_GITHUB_HOSTS and WEFT_GITLAB_HOSTS (comma lists). */
function providerHosts(provider: IntegrationProvider) {
  const extra = (provider === "github" ? process.env.WEFT_GITHUB_HOSTS : process.env.WEFT_GITLAB_HOSTS) ?? "";
  return new Set([provider === "github" ? "github.com" : "gitlab.com", ...extra.split(",").map((host) => host.trim().toLowerCase()).filter(Boolean)]);
}

/** The link as written when it is https on the provider's own host, else null. The link is shown to members, so it must not point anywhere else. */
function providerLink(provider: IntegrationProvider, value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2000) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && providerHosts(provider).has(url.hostname.toLowerCase()) ? url.toString() : null;
  } catch {
    return null;
  }
}

/** When the provider says the object last changed; null when the payload has no readable time. GitLab writes "2026-11-13 09:00:00 UTC". */
function providerTime(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const time = new Date(value.replace(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) UTC$/, "$1T$2Z"));
  return Number.isFinite(time.getTime()) ? time : null;
}

function mapPullRequestState(state: string | undefined, merged: boolean | undefined): PullRequestState {
  if (merged || state === "merged") return "merged";
  return state === "closed" || state === "locked" ? "closed" : "open";
}

function mapGitHubCheck(status: unknown, conclusion: unknown): ChecksState {
  if (status !== "completed") return "pending";
  if (conclusion === "success" || conclusion === "neutral" || conclusion === "skipped") return "passing";
  if (conclusion === null || conclusion === undefined) return "pending";
  return "failing";
}

function mapGitLabPipeline(status: unknown): ChecksState | null {
  if (status === "success") return "passing";
  if (status === "failed" || status === "canceled") return "failing";
  if (status === "skipped") return null;
  return "pending";
}

/** Reads one webhook payload into a pull-request or checks update, or says why it is not one. */
export function parseWebhook(provider: IntegrationProvider, event: string, payload: any): Parsed {
  if (provider === "github") {
    const repository = typeof payload?.repository?.full_name === "string" ? payload.repository.full_name : null;
    if (!repository) return { kind: "invalid", reason: "Payload has no repository" };
    if (event === "pull_request") {
      const pr = payload.pull_request;
      if (!pr || typeof pr.number !== "number") return { kind: "invalid", reason: "Pull request payload is incomplete" };
      const link = providerLink(provider, pr.html_url);
      if (!link) return { kind: "invalid", reason: "Pull request link is not an https link on the provider's host" };
      return { kind: "pull_request", pr: { provider, repository: repository.toLowerCase(), number: pr.number, title: String(pr.title ?? ""), url: link, occurredAt: providerTime(pr.updated_at), branches: [pr.head?.ref].filter((value): value is string => typeof value === "string"), text: [String(pr.title ?? ""), String(pr.body ?? "")], state: mapPullRequestState(pr.state, pr.merged === true), headSha: typeof pr.head?.sha === "string" ? pr.head.sha : null } };
    }
    if (event === "check_run" || event === "check_suite") {
      const item = event === "check_run" ? payload.check_run : payload.check_suite;
      if (!item) return { kind: "invalid", reason: "Check payload is incomplete" };
      const checks = mapGitHubCheck(item.status, item.conclusion);
      const headSha = typeof item.head_sha === "string" ? item.head_sha : null;
      const numbers = (Array.isArray(item.pull_requests) ? item.pull_requests : []).map((pr: { number?: unknown }) => pr.number).filter((value: unknown): value is number => typeof value === "number");
      if (!numbers.length) return { kind: "ignored", reason: "Checks not tied to a pull request" };
      return { kind: "checks", check: { repository: repository.toLowerCase(), number: numbers[0], headSha, checks, occurredAt: providerTime(item.updated_at ?? item.completed_at ?? item.started_at) } };
    }
    return { kind: "ignored", reason: `Event ${event} is not used` };
  }
  // GitLab
  const repository = typeof payload?.project?.path_with_namespace === "string" ? payload.project.path_with_namespace : null;
  if (!repository) return { kind: "invalid", reason: "Payload has no project" };
  if (event === "Merge Request Hook") {
    const attributes = payload.object_attributes;
    if (!attributes || typeof attributes.iid !== "number") return { kind: "invalid", reason: "Merge request payload is incomplete" };
    const link = providerLink(provider, attributes.url);
    if (!link) return { kind: "invalid", reason: "Merge request link is not an https link on the provider's host" };
    return { kind: "pull_request", pr: { provider, repository: repository.toLowerCase(), number: attributes.iid, title: String(attributes.title ?? ""), url: link, occurredAt: providerTime(attributes.updated_at), branches: [attributes.source_branch].filter((value): value is string => typeof value === "string"), text: [String(attributes.title ?? ""), String(attributes.description ?? "")], state: mapPullRequestState(attributes.state, false), headSha: typeof attributes.last_commit?.id === "string" ? attributes.last_commit.id : null } };
  }
  if (event === "Pipeline Hook") {
    const attributes = payload.object_attributes;
    const checks = mapGitLabPipeline(attributes?.status);
    if (!checks) return { kind: "ignored", reason: "Pipeline has no check result" };
    const requests = [payload.merge_request, ...(Array.isArray(payload.merge_requests) ? payload.merge_requests : [])].filter((request) => typeof request?.iid === "number");
    if (!requests.length) return { kind: "ignored", reason: "Pipeline not tied to a merge request" };
    return { kind: "checks", check: { repository: repository.toLowerCase(), number: requests[0].iid, headSha: typeof attributes.sha === "string" ? attributes.sha : null, checks, occurredAt: providerTime(attributes.finished_at ?? attributes.created_at) } };
  }
  return { kind: "ignored", reason: `Event ${event} is not used` };
}

function verifySignature(provider: IntegrationProvider, secret: string, header: (name: string) => string | null, rawBody: string) {
  if (provider === "github") {
    const given = header("x-hub-signature-256");
    if (!given?.startsWith("sha256=")) return false;
    const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`);
    const received = Buffer.from(given);
    return received.length === expected.length && timingSafeEqual(received, expected);
  }
  // GitLab sends the secret itself in X-Gitlab-Token; compare digests so the length of the secret does not leak.
  const given = header("x-gitlab-token") ?? "";
  return timingSafeEqual(createHash("sha256").update(given).digest(), createHash("sha256").update(secret).digest());
}

function deliveryIdOf(provider: IntegrationProvider, header: (name: string) => string | null, rawBody: string) {
  const id = provider === "github" ? header("x-github-delivery") : header("x-gitlab-event-uuid");
  return id && id.length <= 200 ? `${provider}:${id}` : `${provider}:body:${createHash("sha256").update(rawBody).digest("hex")}`;
}

export function createWorkItemIntegrationActions(db: Database) {
  const workspaceInput = { workspaceId: uuid() };

  async function integrationOf(integrationId: string) {
    const [row] = await db.select().from(workItemIntegrations).where(eq(workItemIntegrations.id, integrationId));
    if (!row) throw new ActionError("Integration not found", 404);
    return row;
  }
  async function repositoriesOf(integrationId: string) {
    return (await db.select({ fullName: workItemIntegrationRepositories.fullName }).from(workItemIntegrationRepositories)
      .where(eq(workItemIntegrationRepositories.integrationId, integrationId)).orderBy(asc(workItemIntegrationRepositories.fullName))).map((row) => row.fullName);
  }
  async function summarise(row: IntegrationRow) {
    return { id: row.id, provider: row.provider, enabled: row.enabled, repositories: await repositoriesOf(row.id), webhookPath: webhookPath(row.provider, row.id), createdAt: row.createdAt.toISOString() };
  }

  return {
    listWorkItemIntegrations: {
      name: "list_work_item_integrations", kind: "read" as const, input: Type.Object(workspaceInput), output: Type.Array(integrationOutput),
      handler: async (context: { userId: string }, input: { workspaceId: string }) => {
        await requireWorkspaceRole(db, context.userId, input.workspaceId, "admin");
        const rows = await db.select().from(workItemIntegrations).where(eq(workItemIntegrations.workspaceId, input.workspaceId)).orderBy(asc(workItemIntegrations.provider));
        return Promise.all(rows.map(summarise));
      },
    },
    createWorkItemIntegration: {
      name: "create_work_item_integration", kind: "write" as const,
      input: Type.Object({ workspaceId: uuid(), provider: Type.Union(integrationProviders.map((value) => Type.Literal(value))) }),
      output: Type.Object({ id: Type.String(), provider: Type.String(), enabled: Type.Boolean(), webhookPath: Type.String(), secret: Type.String() }),
      handler: async (context: { userId: string }, input: { workspaceId: string; provider: IntegrationProvider }) => {
        await requireWorkspaceRole(db, context.userId, input.workspaceId, "admin");
        const secret = randomBytes(32).toString("hex");
        const [existing] = await db.select({ id: workItemIntegrations.id }).from(workItemIntegrations).where(and(eq(workItemIntegrations.workspaceId, input.workspaceId), eq(workItemIntegrations.provider, input.provider)));
        if (existing) throw new ActionError("This workspace already has an integration for this provider", 409);
        const [row] = await db.insert(workItemIntegrations).values({ workspaceId: input.workspaceId, provider: input.provider, secretSealed: sealSecret(secret), createdBy: context.userId }).returning();
        await auditAgentChange(db, { workspaceId: input.workspaceId, entityType: "workspace", entityId: input.workspaceId, field: `integration.${input.provider}.created`, oldValue: null, newValue: row!.id, actorId: context.userId });
        // The secret is returned once, here; later reads only see that one exists.
        return { id: row!.id, provider: row!.provider, enabled: row!.enabled, webhookPath: webhookPath(row!.provider, row!.id), secret };
      },
    },
    updateWorkItemIntegration: {
      name: "update_work_item_integration", kind: "write" as const,
      input: Type.Object({ integrationId: uuid(), enabled: Type.Optional(Type.Boolean()), repositories: Type.Optional(Type.Array(repositoryField, { maxItems: maxRepositoriesPerIntegration })) }),
      output: integrationOutput,
      handler: async (context: { userId: string }, input: { integrationId: string; enabled?: boolean; repositories?: string[] }) => {
        const before = await integrationOf(input.integrationId);
        await requireWorkspaceRole(db, context.userId, before.workspaceId, "admin");
        const repositories = input.repositories ? [...new Set(input.repositories.map(normaliseRepository))] : undefined;
        const previous = await repositoriesOf(before.id);
        const updated = await db.transaction(async (tx) => {
          const database = tx as unknown as Database;
          const [row] = await database.update(workItemIntegrations).set({ ...(input.enabled === undefined ? {} : { enabled: input.enabled }), updatedAt: new Date() }).where(eq(workItemIntegrations.id, before.id)).returning();
          if (repositories) {
            await database.delete(workItemIntegrationRepositories).where(eq(workItemIntegrationRepositories.integrationId, before.id));
            if (repositories.length) await database.insert(workItemIntegrationRepositories).values(repositories.map((fullName) => ({ integrationId: before.id, fullName })));
          }
          return row!;
        });
        if (input.enabled !== undefined && input.enabled !== before.enabled) await auditAgentChange(db, { workspaceId: before.workspaceId, entityType: "workspace", entityId: before.workspaceId, field: `integration.${before.provider}.enabled`, oldValue: before.enabled, newValue: input.enabled, actorId: context.userId });
        if (repositories && JSON.stringify([...repositories].sort()) !== JSON.stringify([...previous].sort())) await auditAgentChange(db, { workspaceId: before.workspaceId, entityType: "workspace", entityId: before.workspaceId, field: `integration.${before.provider}.repositories`, oldValue: previous, newValue: repositories, actorId: context.userId });
        return summarise(updated);
      },
    },
    rotateWorkItemIntegrationSecret: {
      name: "rotate_work_item_integration_secret", kind: "write" as const,
      input: Type.Object({ integrationId: uuid() }),
      output: Type.Object({ secret: Type.String() }),
      handler: async (context: { userId: string }, input: { integrationId: string }) => {
        const row = await integrationOf(input.integrationId);
        await requireWorkspaceRole(db, context.userId, row.workspaceId, "admin");
        const secret = randomBytes(32).toString("hex");
        await db.update(workItemIntegrations).set({ secretSealed: sealSecret(secret), updatedAt: new Date() }).where(eq(workItemIntegrations.id, row.id));
        await auditAgentChange(db, { workspaceId: row.workspaceId, entityType: "workspace", entityId: row.workspaceId, field: `integration.${row.provider}.secret`, oldValue: null, newValue: "rotated", actorId: context.userId });
        return { secret };
      },
    },
    listWorkItemPullRequests: {
      name: "list_work_item_pull_requests", kind: "read" as const,
      input: Type.Object({ workItemId: uuid() }), output: Type.Array(pullRequestOutput),
      handler: async (context: { userId: string }, input: { workItemId: string }) => {
        const [item] = await db.select().from(workItems).where(eq(workItems.id, input.workItemId));
        if (!item) throw new ActionError("Work item not found", 404);
        await requireProjectAccess(db, context.userId, item.projectId, "read");
        const rows = await db.select().from(workItemPullRequests).where(eq(workItemPullRequests.workItemId, item.id)).orderBy(asc(workItemPullRequests.createdAt), asc(workItemPullRequests.number));
        return rows.map((row) => ({ id: row.id, workItemId: row.workItemId, provider: row.provider, repository: row.repository, number: row.number, title: row.title, url: row.url, state: row.state, checks: row.checks, updatedAt: row.updatedAt.toISOString() }));
      },
    },
    getProjectMergedPrSetting: {
      name: "get_project_merged_pr_setting", kind: "read" as const,
      input: Type.Object({ projectId: uuid() }), output: Type.Object({ movesToDone: Type.Boolean() }),
      handler: async (context: { userId: string }, input: { projectId: string }) => {
        const { project } = await requireProjectAccess(db, context.userId, input.projectId, "read");
        return { movesToDone: project.mergedPrMovesToDone };
      },
    },
    setProjectMergedPrSetting: {
      name: "set_project_merged_pr_setting", kind: "write" as const,
      input: Type.Object({ projectId: uuid(), movesToDone: Type.Boolean() }), output: Type.Object({ movesToDone: Type.Boolean() }),
      handler: async (context: { userId: string }, input: { projectId: string; movesToDone: boolean }) => {
        const { project } = await requireProjectAccess(db, context.userId, input.projectId, "admin");
        if (project.mergedPrMovesToDone !== input.movesToDone) {
          await db.update(projects).set({ mergedPrMovesToDone: input.movesToDone }).where(eq(projects.id, project.id));
          await auditAgentChange(db, { workspaceId: project.workspaceId, entityType: "workspace", entityId: project.workspaceId, field: `project.${project.key}.merged_pr_moves_to_done`, oldValue: project.mergedPrMovesToDone, newValue: input.movesToDone, actorId: context.userId });
        }
        return { movesToDone: input.movesToDone };
      },
    },
  };
}

/** Finds the live, unarchived work items that the keys in the texts point to, in projects of this workspace. */
async function linkTargets(database: Database, workspaceId: string, texts: string[]) {
  const targets: Array<{ item: typeof workItems.$inferSelect; project: typeof projects.$inferSelect }> = [];
  for (const { key, number } of workItemKeysIn(texts)) {
    let [project] = await database.select().from(projects).where(and(eq(projects.workspaceId, workspaceId), eq(projects.key, key)));
    if (!project) {
      const [alias] = await database.select({ projectId: projectKeyAliases.projectId }).from(projectKeyAliases).where(and(eq(projectKeyAliases.workspaceId, workspaceId), eq(projectKeyAliases.key, key)));
      if (alias) [project] = await database.select().from(projects).where(eq(projects.id, alias.projectId));
    }
    if (!project || project.archivedAt) continue;
    const [item] = await database.select().from(workItems).where(and(eq(workItems.projectId, project.id), eq(workItems.sequence, number), unarchivedWorkItems));
    if (item) targets.push({ item, project });
  }
  return targets;
}

/** Moves a work item to its project's first done state, unless it is already done or cancelled. */
async function moveToDone(database: Database, context: ActivityContext, item: typeof workItems.$inferSelect, project: typeof projects.$inferSelect) {
  const [current] = await database.select({ group: workItemStates.group }).from(workItemStates).where(eq(workItemStates.id, item.stateId));
  if (!current || current.group === "completed" || current.group === "cancelled") return;
  const [done] = await database.select().from(workItemStates).where(and(eq(workItemStates.projectId, project.id), eq(workItemStates.group, "completed"))).orderBy(asc(workItemStates.sortOrder)).limit(1);
  if (!done) return;
  await database.update(workItems).set({ stateId: done.id, updatedAt: new Date() }).where(eq(workItems.id, item.id));
  await logActivity(database, context, { workspaceId: item.workspaceId, projectId: project.id, entityType: "work_item", entityId: item.id, field: "state", oldValue: item.stateId, newValue: done.id });
}

/** True when the payload is older than what is stored, so applying it would undo a newer change. A payload without a time is never stale. */
function isStale(row: PullRequestRow, occurredAt: Date | null) {
  return occurredAt !== null && row.updatedAt.getTime() > occurredAt.getTime();
}

/** The time stored for a change: the provider's, never later than now. */
function stamp(occurredAt: Date | null) {
  const now = new Date();
  return occurredAt && occurredAt < now ? occurredAt : now;
}

const checkRank: Record<ChecksState, number> = { none: 0, passing: 1, pending: 2, failing: 3 };

/**
 * Handles one repository webhook for one integration. The signature is checked first, and a delivery id that was
 * already accepted is answered without changing anything. A repository the integration does not list is ignored.
 */
export async function receiveRepositoryWebhook(db: Database, input: { integrationId: string; provider: string; header: (name: string) => string | null; rawBody: string }): Promise<WebhookResult> {
  if (!(integrationProviders as readonly string[]).includes(input.provider)) return { status: 404, body: { error: "Not found" } };
  const provider = input.provider as IntegrationProvider;
  const [integration] = await db.select().from(workItemIntegrations).where(and(eq(workItemIntegrations.id, input.integrationId), eq(workItemIntegrations.provider, provider)));
  if (!integration || !integration.enabled) return { status: 404, body: { error: "Not found" } };
  const secret = openSecret(integration.secretSealed);
  if (!verifySignature(provider, secret, input.header, input.rawBody)) return { status: 401, body: { error: "Invalid signature" } };

  let payload: unknown;
  try { payload = JSON.parse(input.rawBody); } catch { return { status: 400, body: { error: "Body is not JSON" } }; }
  const event = (provider === "github" ? input.header("x-github-event") : input.header("x-gitlab-event")) ?? "";
  const deliveryId = deliveryIdOf(provider, input.header, input.rawBody);

  return db.transaction(async (tx): Promise<WebhookResult> => {
    const database = tx as unknown as Database;
    const bodyHash = createHash("sha256").update(input.rawBody).digest("hex");
    const accepted = await database.insert(workItemIntegrationDeliveries).values([{ integrationId: integration.id, deliveryId }, { integrationId: integration.id, deliveryId: `${provider}:body:${bodyHash}` }]).onConflictDoNothing().returning({ deliveryId: workItemIntegrationDeliveries.deliveryId });
    if (!accepted.some((row) => row.deliveryId === deliveryId) || !accepted.some((row) => row.deliveryId === `${provider}:body:${bodyHash}`)) return { status: 200, body: { result: "ignored", reason: "Delivery already received" } };

    const parsed = parseWebhook(provider, event, payload);
    if (parsed.kind === "invalid") return { status: 400, body: { error: parsed.reason } };
    if (parsed.kind === "ignored") return { status: 200, body: { result: "ignored", reason: parsed.reason } };
    const repository = parsed.kind === "pull_request" ? parsed.pr.repository : parsed.check.repository;
    const listed = await database.select({ id: workItemIntegrationRepositories.id }).from(workItemIntegrationRepositories)
      .where(and(eq(workItemIntegrationRepositories.integrationId, integration.id), eq(workItemIntegrationRepositories.fullName, repository)));
    if (!listed.length) return { status: 200, body: { result: "ignored", reason: "Repository is not connected to this workspace" } };

    const actor = { userId: integration.createdBy, source: "integration" as const };
    if (parsed.kind === "checks") {
      const { number, headSha, checks } = parsed.check;
      if (!headSha) return { status: 200, body: { result: "checks", linked: 0 } };
      const rows = await database.select().from(workItemPullRequests).where(and(eq(workItemPullRequests.workspaceId, integration.workspaceId), eq(workItemPullRequests.provider, provider), eq(workItemPullRequests.repository, repository), eq(workItemPullRequests.number, number))).orderBy(asc(workItemPullRequests.id)).for("update");
      let updated = 0;
      for (const row of rows) {
        // A check for a different head is stale; on the current SHA status only moves up the conservative ranking.
        if (row.headSha !== headSha) continue;
        const next = checkRank[row.checks as ChecksState] >= checkRank[checks] ? row.checks as ChecksState : checks;
        if (next !== row.checks) {
          await database.update(workItemPullRequests).set({ checks: next }).where(eq(workItemPullRequests.id, row.id));
          updated += 1;
        }
      }
      return { status: 200, body: { result: "checks", linked: updated } };
    }

    const pr = parsed.pr;
    const existing = await database.select().from(workItemPullRequests).where(and(eq(workItemPullRequests.workspaceId, integration.workspaceId), eq(workItemPullRequests.provider, provider), eq(workItemPullRequests.repository, repository), eq(workItemPullRequests.number, pr.number))).orderBy(asc(workItemPullRequests.id)).for("update");
    const targets = await linkTargets(database, integration.workspaceId, [...pr.branches, ...pr.text]);
    const linkedItems = new Set(existing.map((row) => row.workItemId));
    const newIds = new Set<string>();
    let linked = 0;
    for (const target of targets) {
      if (linkedItems.has(target.item.id)) continue;
      const [row] = await database.insert(workItemPullRequests).values({ workspaceId: integration.workspaceId, projectId: target.project.id, workItemId: target.item.id, provider, repository, number: pr.number, title: pr.title, url: pr.url, state: pr.state, headSha: pr.headSha, updatedAt: stamp(pr.occurredAt) }).returning();
      existing.push(row!);
      newIds.add(row!.id);
      linked += 1;
      await logActivity(database, actor, { workspaceId: integration.workspaceId, projectId: target.project.id, entityType: "work_item", entityId: target.item.id, field: "pull_request_linked", newValue: { provider, repository, number: pr.number, title: pr.title, url: pr.url, state: pr.state } });
    }

    const transitions: string[] = [];
    for (const row of existing) {
      const isNew = newIds.has(row.id);
      // An older payload (a replay or an out-of-order delivery) changes nothing on a row that has seen newer news.
      if (!isNew && isStale(row, pr.occurredAt)) continue;
      const stateChanged = !isNew && row.state !== pr.state;
      // A merge moves the item once: when the link is new and already merged, or when the state turns merged now.
      const mergedNow = pr.state === "merged" && (isNew || row.state !== "merged");
      const headChanged = row.headSha !== pr.headSha && pr.headSha !== null;
      await database.update(workItemPullRequests).set({ title: pr.title, url: pr.url, state: pr.state, ...(headChanged ? { headSha: pr.headSha, checks: "none" as ChecksState } : {}), updatedAt: stamp(pr.occurredAt) }).where(eq(workItemPullRequests.id, row.id));
      if (stateChanged) {
        await logActivity(database, actor, { workspaceId: integration.workspaceId, projectId: row.projectId, entityType: "work_item", entityId: row.workItemId, field: "pull_request_state", oldValue: { number: pr.number, repository, state: row.state }, newValue: { number: pr.number, repository, state: pr.state } });
      }
      if (mergedNow) {
        const [item] = await database.select().from(workItems).where(eq(workItems.id, row.workItemId));
        const [project] = await database.select().from(projects).where(eq(projects.id, row.projectId));
        if (item && project?.mergedPrMovesToDone && !item.archivedAt && !item.deletedAt) await moveToDone(database, actor, item, project);
        transitions.push(row.workItemId);
      }
    }
    return { status: 200, body: { result: "pull_request", linked, updated: existing.length, transitions: transitions.length } };
  });
}
