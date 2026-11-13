import { afterAll, expect, test } from "bun:test";
import { createHmac, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { activities, createDatabase, projects, workItemIntegrationDeliveries, workItemIntegrations, workItemPullRequests, workItemStates, workItems, workspaces, type Database } from "@weft/db";
import { createMemberFactory, createWorkspaceFactory, withRollback } from "../../db/src/test-helpers";
import { agentMayUseAction, createActionList, purgeIntegrationDeliveries, createProjectActions, createWorkItemActions, createWorkItemIntegrationActions, receiveRepositoryWebhook } from "../src";
import { openSecret, sealSecret } from "../src/integration-secrets";

const { client, db } = createDatabase();
afterAll(async () => client.end());

type Headers = Record<string, string>;
const sign = (secret: string, body: string) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

/** A GitHub delivery with a valid signature for the given secret (or an explicit bad one). */
function github(secret: string, event: string, payload: unknown, options: { delivery?: string; signature?: string | null } = {}) {
  const rawBody = JSON.stringify(payload);
  const headers: Headers = { "x-github-event": event, "x-github-delivery": options.delivery ?? randomUUID() };
  if (options.signature !== null) headers["x-hub-signature-256"] = options.signature ?? sign(secret, rawBody);
  return { rawBody, headers };
}

/** A GitLab delivery; the secret travels in X-Gitlab-Token. */
function gitlab(token: string, event: string, payload: unknown, options: { uuid?: string } = {}) {
  return { rawBody: JSON.stringify(payload), headers: { "x-gitlab-event": event, "x-gitlab-token": token, "x-gitlab-event-uuid": options.uuid ?? randomUUID() } };
}

async function receive(tx: Database, integrationId: string, provider: string, delivery: { rawBody: string; headers: Headers }) {
  return receiveRepositoryWebhook(tx, { integrationId, provider, rawBody: delivery.rawBody, header: (name) => delivery.headers[name.toLowerCase()] ?? null });
}

async function setup(tx: Database) {
  const workspace = await createWorkspaceFactory(tx);
  const admin = await createMemberFactory(tx, workspace.id, "Admin");
  const member = await createMemberFactory(tx, workspace.id, "Member");
  const projects = createProjectActions(tx);
  const items = createWorkItemActions(tx);
  const app = await projects.createProject.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "App", key: "APP", visibility: "public" });
  const other = await projects.createProject.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Ops", key: "OPS", visibility: "public" });
  const workItem = async (projectId: string, title: string) => items.createWorkItem.handler({ userId: member.id }, { projectId, title });
  const sequenceOf = async (id: string) => (await tx.select().from(workItems).where(eq(workItems.id, id)))[0]!.sequence;
  await projects.addProjectMember.handler({ userId: admin.id }, { projectId: app.id, userId: member.id, role: "Member" });
  await projects.addProjectMember.handler({ userId: admin.id }, { projectId: other.id, userId: member.id, role: "Member" });
  const actions = createWorkItemIntegrationActions(tx);
  const created = await actions.createWorkItemIntegration.handler({ userId: admin.id }, { workspaceId: workspace.id, provider: "github" });
  await actions.updateWorkItemIntegration.handler({ userId: admin.id }, { integrationId: created.id, enabled: true, repositories: ["Acme/App"] });
  return { workspace, admin, member, app, other, workItem, sequenceOf, actions, integrationId: created.id, secret: created.secret, tx };
}

test.concurrent("a GitHub webhook needs a valid signature; a bad or missing one changes nothing", async () => withRollback(db, async (tx) => {
  const s = await setup(tx);
  const item = await s.workItem(s.app.id, "Login");
  const seq = await s.sequenceOf(item.id);
  const payload = { repository: { full_name: "Acme/App" }, action: "opened", pull_request: { number: 7, title: `APP-${seq} fix login`, body: "", html_url: "https://github.com/Acme/App/pull/7", state: "open", merged: false, head: { ref: "fix/login", sha: "abc" } } };
  const wrong = await receive(tx, s.integrationId, "github", github("not-the-secret", "pull_request", payload));
  const missing = await receive(tx, s.integrationId, "github", github(s.secret, "pull_request", payload, { signature: null }));
  const malformed = await receive(tx, s.integrationId, "github", github(s.secret, "pull_request", payload, { signature: "sha1=00" }));
  expect([wrong.status, missing.status, malformed.status]).toEqual([401, 401, 401]);
  expect(await tx.select().from(workItemPullRequests)).toHaveLength(0);
  const good = await receive(tx, s.integrationId, "github", github(s.secret, "pull_request", payload));
  expect(good.status).toBe(200);
  expect(await tx.select().from(workItemPullRequests)).toHaveLength(1);
}));

test.concurrent("a GitLab webhook must send the secret token; a wrong one is refused", async () => withRollback(db, async (tx) => {
  const s = await setup(tx);
  const gitlabIntegration = await s.actions.createWorkItemIntegration.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id, provider: "gitlab" });
  await s.actions.updateWorkItemIntegration.handler({ userId: s.admin.id }, { integrationId: gitlabIntegration.id, enabled: true, repositories: ["platform/tools"] });
  const item = await s.workItem(s.app.id, "Tools");
  const seq = await s.sequenceOf(item.id);
  const payload = { object_kind: "merge_request", project: { path_with_namespace: "platform/tools" }, object_attributes: { iid: 3, title: `APP-${seq} tools`, description: "", source_branch: "tools", url: "https://gitlab.com/platform/tools/-/merge_requests/3", state: "opened", action: "open" } };
  expect((await receive(tx, gitlabIntegration.id, "gitlab", gitlab("guess", "Merge Request Hook", payload))).status).toBe(401);
  expect((await receive(tx, gitlabIntegration.id, "gitlab", gitlab(gitlabIntegration.secret, "Merge Request Hook", payload))).status).toBe(200);
  expect(await tx.select().from(workItemPullRequests)).toHaveLength(1);
}));

test.concurrent("a replayed delivery id is ignored and writes nothing new", async () => withRollback(db, async (tx) => {
  const s = await setup(tx);
  const item = await s.workItem(s.app.id, "Replay");
  const seq = await s.sequenceOf(item.id);
  const delivery = github(s.secret, "pull_request", { repository: { full_name: "Acme/App" }, pull_request: { number: 9, title: `APP-${seq}`, body: "", html_url: "https://github.com/Acme/App/pull/9", state: "open", head: { ref: "x", sha: "h1" } } }, { delivery: "fixed-delivery-1" });
  expect((await receive(tx, s.integrationId, "github", delivery)).body).toMatchObject({ result: "pull_request" });
  const before = await tx.select().from(activities);
  const replay = await receive(tx, s.integrationId, "github", delivery);
  expect(replay.body).toMatchObject({ result: "ignored", reason: "Delivery already received" });
  const newDeliveryId = { ...delivery, headers: { ...delivery.headers, "x-github-delivery": "fixed-delivery-2" } };
  expect((await receive(tx, s.integrationId, "github", newDeliveryId)).body).toMatchObject({ result: "ignored", reason: "Delivery already received" });
  expect(await tx.select().from(activities)).toHaveLength(before.length);
}));

test.concurrent("a PR that mentions a key in its branch, title or body is linked, shown with its state, and logged", async () => withRollback(db, async (tx) => {
  const s = await setup(tx);
  const a = await s.workItem(s.app.id, "A"); const b = await s.workItem(s.app.id, "B"); const c = await s.workItem(s.app.id, "C");
  const pr = (number: number, title: string, body: string, branch: string) => github(s.secret, "pull_request", { repository: { full_name: "Acme/App" }, pull_request: { number, title, body, html_url: `https://github.com/Acme/App/pull/${number}`, state: "open", merged: false, head: { ref: branch, sha: `sha-${number}` } } });
  const seqA = await s.sequenceOf(a.id); const seqB = await s.sequenceOf(b.id); const seqC = await s.sequenceOf(c.id);
  await receive(tx, s.integrationId, "github", pr(1, "No key here", "", `app-${seqA}-branch`));
  await receive(tx, s.integrationId, "github", pr(2, `Fix APP-${seqB}`, "", "fix"));
  await receive(tx, s.integrationId, "github", pr(3, "Work", `Closes APP-${seqC}.`, "work"));
  const list = async (id: string) => s.actions.listWorkItemPullRequests.handler({ userId: s.member.id }, { workItemId: id });
  expect((await list(a.id)).map((row) => [row.number, row.state, row.checks])).toEqual([[1, "open", "none"]]);
  expect((await list(b.id)).map((row) => row.number)).toEqual([2]);
  expect((await list(c.id)).map((row) => row.number)).toEqual([3]);
  const logged = await tx.select().from(activities).where(and(eq(activities.entityId, b.id), eq(activities.field, "pull_request_linked")));
  expect(logged).toHaveLength(1);
  expect(logged[0]!.source).toBe("integration");
  expect(logged[0]!.actorId).toBe(s.admin.id);
}));

test.concurrent("a merge moves the item to the done state only when its project enabled it", async () => withRollback(db, async (tx) => {
  const s = await setup(tx);
  const onItem = await s.workItem(s.app.id, "On"); const offItem = await s.workItem(s.other.id, "Off");
  const seqOn = await s.sequenceOf(onItem.id); const seqOff = await s.sequenceOf(offItem.id);
  const doneOf = async (projectId: string) => (await tx.select().from(workItemStates).where(and(eq(workItemStates.projectId, projectId), eq(workItemStates.group, "completed"))).orderBy(workItemStates.sortOrder))[0]!.id;
  await s.actions.setProjectMergedPrSetting.handler({ userId: s.admin.id }, { projectId: s.app.id, movesToDone: true });
  expect(await s.actions.getProjectMergedPrSetting.handler({ userId: s.member.id }, { projectId: s.app.id })).toEqual({ movesToDone: true });
  const merged = (number: number, title: string) => github(s.secret, "pull_request", { repository: { full_name: "Acme/App" }, pull_request: { number, title, body: "", html_url: `https://github.com/Acme/App/pull/${number}`, state: "closed", merged: true, head: { ref: "m", sha: "m1" } } });
  await receive(tx, s.integrationId, "github", github(s.secret, "pull_request", { repository: { full_name: "Acme/App" }, pull_request: { number: 20, title: `APP-${seqOn} and OPS-${seqOff}`, body: "", html_url: "https://github.com/acme/app/pull/1", state: "open", merged: false, head: { ref: "p", sha: "p1" } } }));
  const result = await receive(tx, s.integrationId, "github", merged(20, `APP-${seqOn} and OPS-${seqOff}`));
  expect(result.status).toBe(200);
  const [onRow] = await tx.select().from(workItems).where(eq(workItems.id, onItem.id));
  const [offRow] = await tx.select().from(workItems).where(eq(workItems.id, offItem.id));
  expect(onRow!.stateId).toBe(await doneOf(s.app.id));
  expect(onRow!.completedAt).not.toBeNull();
  expect(offRow!.stateId).toBe(offItem.stateId);
  expect((await s.actions.listWorkItemPullRequests.handler({ userId: s.member.id }, { workItemId: onItem.id }))[0]!.state).toBe("merged");
  expect((await tx.select().from(activities).where(and(eq(activities.entityId, onItem.id), eq(activities.field, "state"))))).toHaveLength(1);
}));

test.concurrent("the done-state move is refused for members and off unless a project admin switches it on", async () => withRollback(db, async (tx) => {
  const s = await setup(tx);
  const projectMember = await createMemberFactory(tx, s.workspace.id, "Member");
  await createProjectActions(tx).addProjectMember.handler({ userId: s.admin.id }, { projectId: s.app.id, userId: projectMember.id, role: "Member" });
  await expect(s.actions.setProjectMergedPrSetting.handler({ userId: projectMember.id }, { projectId: s.app.id, movesToDone: true })).rejects.toMatchObject({ status: 403 });
  expect(await s.actions.getProjectMergedPrSetting.handler({ userId: projectMember.id }, { projectId: s.app.id })).toEqual({ movesToDone: false });
  const [row] = await tx.select().from(projects).where(eq(projects.id, s.app.id));
  expect(row!.mergedPrMovesToDone).toBe(false);
}));

test.concurrent("unlisted repositories are ignored, and another workspace's integration cannot write to this one", async () => withRollback(db, async (tx) => {
  const s = await setup(tx);
  const item = await s.workItem(s.app.id, "Scope");
  const seq = await s.sequenceOf(item.id);
  const payload = (repo: string, number: number) => ({ repository: { full_name: repo }, pull_request: { number, title: `APP-${seq}`, body: "", html_url: "https://github.com/acme/app/pull/1", state: "open", merged: false, head: { ref: "x", sha: "x1" } } });
  // A repository that this workspace does not list is ignored, even with a valid signature and a matching key.
  const unlisted = await receive(tx, s.integrationId, "github", github(s.secret, "pull_request", payload("evil/other", 1)));
  expect(unlisted.body).toMatchObject({ result: "ignored", reason: "Repository is not connected to this workspace" });
  // A second workspace listing the same repository gets its own secret; its deliveries never reach this workspace's items.
  const foreign = await createWorkspaceFactory(tx);
  const foreignAdmin = await createMemberFactory(tx, foreign.id, "Admin");
  const foreignIntegration = await s.actions.createWorkItemIntegration.handler({ userId: foreignAdmin.id }, { workspaceId: foreign.id, provider: "github" });
  await s.actions.updateWorkItemIntegration.handler({ userId: foreignAdmin.id }, { integrationId: foreignIntegration.id, enabled: true, repositories: ["acme/app"] });
  const crossed = await receive(tx, foreignIntegration.id, "github", github(foreignIntegration.secret, "pull_request", payload("Acme/App", 2)));
  expect(crossed.status).toBe(200);
  expect(await tx.select().from(workItemPullRequests).where(eq(workItemPullRequests.workItemId, item.id))).toHaveLength(0);
  // Its signature does not verify against this workspace's integration.
  expect((await receive(tx, s.integrationId, "github", github(foreignIntegration.secret, "pull_request", payload("Acme/App", 3)))).status).toBe(401);
  // A disabled integration answers as if it did not exist.
  await s.actions.updateWorkItemIntegration.handler({ userId: s.admin.id }, { integrationId: s.integrationId, enabled: false });
  expect((await receive(tx, s.integrationId, "github", github(s.secret, "pull_request", payload("Acme/App", 4)))).status).toBe(404);
}));

test.concurrent("checks rank failure above pending and passing for one head, and a new head resets", async () => withRollback(db, async (tx) => {
  const s = await setup(tx);
  const item = await s.workItem(s.app.id, "Checks");
  const seq = await s.sequenceOf(item.id);
  await receive(tx, s.integrationId, "github", github(s.secret, "pull_request", { repository: { full_name: "Acme/App" }, pull_request: { number: 5, title: `APP-${seq}`, body: "", html_url: "https://github.com/acme/app/pull/1", state: "open", merged: false, head: { ref: "c", sha: "head-1" } } }));
  const check = (headSha: string, status: string, conclusion: string | null, name: string, updated_at?: string) => github(s.secret, "check_run", { repository: { full_name: "Acme/App" }, check_run: { name, head_sha: headSha, status, conclusion, updated_at, pull_requests: [{ number: 5 }] } });
  await receive(tx, s.integrationId, "github", check("head-1", "completed", "failure", "job A"));
  await receive(tx, s.integrationId, "github", check("head-1", "in_progress", null, "job B"));
  await receive(tx, s.integrationId, "github", check("head-1", "completed", "success", "job B"));
  expect((await s.actions.listWorkItemPullRequests.handler({ userId: s.member.id }, { workItemId: item.id }))[0]!.checks).toBe("failing");
  await receive(tx, s.integrationId, "github", github(s.secret, "pull_request", { repository: { full_name: "Acme/App" }, pull_request: { number: 5, title: `APP-${seq}`, body: "", html_url: "https://github.com/acme/app/pull/1", state: "open", head: { ref: "c", sha: "head-2" } } }));
  expect((await s.actions.listWorkItemPullRequests.handler({ userId: s.member.id }, { workItemId: item.id }))[0]!.checks).toBe("none");
  await receive(tx, s.integrationId, "github", check("head-2", "completed", "success", "job B"));
  const [afterPass] = await s.actions.listWorkItemPullRequests.handler({ userId: s.member.id }, { workItemId: item.id });
  expect(afterPass!.checks).toBe("passing");
  await receive(tx, s.integrationId, "github", check("old-head", "completed", "failure", "job A"));
  expect((await s.actions.listWorkItemPullRequests.handler({ userId: s.member.id }, { workItemId: item.id }))[0]!.checks).toBe("passing");
  await receive(tx, s.integrationId, "github", check("head-2", "completed", "timed_out", "job A"));
  expect((await s.actions.listWorkItemPullRequests.handler({ userId: s.member.id }, { workItemId: item.id }))[0]!.checks).toBe("failing");
}));

test.concurrent("a pull request merge older than a newer check event is still applied", async () => withRollback(db, async (tx) => {
  const s = await setup(tx);
  const item = await s.workItem(s.app.id, "Merge after checks");
  const title = `APP-${await s.sequenceOf(item.id)}`;
  const pr = (state: string, merged: boolean, updated_at: string) => github(s.secret, "pull_request", pullRequestPayload(title, { number: 42, state, merged, updated_at }));
  await receive(tx, s.integrationId, "github", pr("open", false, "2026-11-13T10:00:00Z"));
  await receive(tx, s.integrationId, "github", github(s.secret, "check_run", { repository: { full_name: "Acme/App" }, check_run: { name: "job", head_sha: "s1", status: "completed", conclusion: "success", updated_at: "2026-11-13T12:00:00Z", pull_requests: [{ number: 42 }] } }));
  await receive(tx, s.integrationId, "github", pr("closed", true, "2026-11-13T11:00:00Z"));
  expect((await s.actions.listWorkItemPullRequests.handler({ userId: s.member.id }, { workItemId: item.id }))[0]!.state).toBe("merged");
}));

test.concurrent("concurrent check deliveries do not lose a failure", async () => {
  const s = await setup(db);
  try {
  const item = await s.workItem(s.app.id, "Concurrent checks");
  const title = `APP-${await s.sequenceOf(item.id)}`;
  await receive(db, s.integrationId, "github", github(s.secret, "pull_request", pullRequestPayload(title, { number: 43, head: { ref: "r", sha: "same-head" } })));
  const check = (id: string, conclusion: string) => github(s.secret, "check_run", { repository: { full_name: "Acme/App" }, check_run: { name: id, head_sha: "same-head", status: "completed", conclusion, pull_requests: [{ number: 43 }] } });
  await Promise.all([
    receive(db, s.integrationId, "github", check("failure", "failure")),
    receive(db, s.integrationId, "github", check("passing", "success")),
  ]);
  expect((await s.actions.listWorkItemPullRequests.handler({ userId: s.member.id }, { workItemId: item.id }))[0]!.checks).toBe("failing");
  } finally {
    await db.delete(workspaces).where(eq(workspaces.id, s.workspace.id));
  }
});

test.concurrent("only workspace Admins manage integrations, and the secret is never listed", async () => withRollback(db, async (tx) => {
  const s = await setup(tx);
  await expect(s.actions.createWorkItemIntegration.handler({ userId: s.member.id }, { workspaceId: s.workspace.id, provider: "gitlab" })).rejects.toMatchObject({ status: 403 });
  await expect(s.actions.listWorkItemIntegrations.handler({ userId: s.member.id }, { workspaceId: s.workspace.id })).rejects.toMatchObject({ status: 403 });
  await expect(s.actions.createWorkItemIntegration.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id, provider: "github" })).rejects.toMatchObject({ status: 409 });
  const listed = await s.actions.listWorkItemIntegrations.handler({ userId: s.admin.id }, { workspaceId: s.workspace.id });
  expect(listed).toMatchObject([{ provider: "github", enabled: true, repositories: ["acme/app"] }]);
  expect(JSON.stringify(listed)).not.toContain(s.secret);
  const rotated = await s.actions.rotateWorkItemIntegrationSecret.handler({ userId: s.admin.id }, { integrationId: s.integrationId });
  expect(rotated.secret).not.toBe(s.secret);
  const [row] = await tx.select().from(workItemIntegrations).where(eq(workItemIntegrations.id, s.integrationId));
  expect(openSecret(row!.secretSealed)).toBe(rotated.secret);
  expect(() => openSecret(row!.secretSealed.slice(0, -2) + "xx")).toThrow();
  expect(sealSecret("abc")).not.toContain("abc");
}));

test.concurrent("Agents never get integration actions; list_work_item_pull_requests is the documented read-only exception", async () => {
  const names = createActionList({} as Database).map((action) => action.name);
  expect(names).toEqual(expect.arrayContaining(["list_work_item_pull_requests", "list_work_item_integrations", "create_work_item_integration", "update_work_item_integration", "rotate_work_item_integration_secret", "get_project_merged_pr_setting", "set_project_merged_pr_setting"]));
  const grants = { allowProjectActions: true, allowMemberActions: true, allowFeatureActions: true, allowExportActions: true };
  expect(agentMayUseAction("list_work_item_pull_requests", { allowProjectActions: false, allowMemberActions: false, allowFeatureActions: false, allowExportActions: false })).toBe(true);
  for (const name of ["list_work_item_integrations", "create_work_item_integration", "update_work_item_integration", "rotate_work_item_integration_secret"]) expect(agentMayUseAction(name, grants)).toBe(false);
  expect(agentMayUseAction("set_project_merged_pr_setting", { allowProjectActions: false, allowMemberActions: false, allowFeatureActions: false, allowExportActions: false })).toBe(false);
  const listed = createActionList({} as Database).find((action) => action.name === "list_work_item_pull_requests");
  expect(listed?.kind).toBe("read");
});

const pullRequestPayload = (title: string, overrides: Record<string, unknown> = {}) => ({
  repository: { full_name: "Acme/App" }, action: "opened",
  pull_request: { number: 31, title, body: "", html_url: "https://github.com/Acme/App/pull/31", state: "open", merged: false, head: { ref: "r", sha: "s1" }, updated_at: "2026-11-13T10:00:00Z", ...overrides },
});

test.concurrent("a pull request link must be https on the provider's own host", async () => withRollback(db, async (tx) => {
  const s = await setup(tx);
  const item = await s.workItem(s.app.id, "Link check");
  const title = `APP-${await s.sequenceOf(item.id)} link`;
  for (const url of ["http://github.com/Acme/App/pull/31", "https://evil.example/Acme/App/pull/31", "javascript:alert(1)", "https://github.com.evil.example/x", "https://user:pw@github.com/x", "u"]) {
    const refused = await receive(tx, s.integrationId, "github", github(s.secret, "pull_request", pullRequestPayload(title, { html_url: url })));
    expect(refused.status).toBe(400);
  }
  expect(await tx.select().from(workItemPullRequests).where(eq(workItemPullRequests.workItemId, item.id))).toHaveLength(0);
  const good = await receive(tx, s.integrationId, "github", github(s.secret, "pull_request", pullRequestPayload(title)));
  expect(good.status).toBe(200);
  expect((await s.actions.listWorkItemPullRequests.handler({ userId: s.member.id }, { workItemId: item.id }))[0]!.url).toBe("https://github.com/Acme/App/pull/31");
}));

test.concurrent("a replayed older payload cannot roll a pull request back, and a newer one still applies", async () => withRollback(db, async (tx) => {
  const s = await setup(tx);
  const item = await s.workItem(s.app.id, "Replay");
  const title = `APP-${await s.sequenceOf(item.id)} replay`;
  const state = async () => (await s.actions.listWorkItemPullRequests.handler({ userId: s.member.id }, { workItemId: item.id }))[0]!.state;
  await receive(tx, s.integrationId, "github", github(s.secret, "pull_request", pullRequestPayload(title)));
  await receive(tx, s.integrationId, "github", github(s.secret, "pull_request", pullRequestPayload(title, { state: "closed", merged: true, updated_at: "2026-11-13T11:00:00Z" })));
  expect(await state()).toBe("merged");
  // The first delivery again, under a new delivery id (as an attacker or a retry queue would send it).
  const replay = await receive(tx, s.integrationId, "github", github(s.secret, "pull_request", pullRequestPayload(title)));
  expect(replay.status).toBe(200);
  expect(await state()).toBe("merged");
  await receive(tx, s.integrationId, "github", github(s.secret, "pull_request", pullRequestPayload(title, { state: "open", merged: false, updated_at: "2026-11-13T12:00:00Z" })));
  expect(await state()).toBe("open");
}));

test.concurrent("delivery records older than 30 days are purged and newer ones kept", async () => withRollback(db, async (tx) => {
  const s = await setup(tx);
  const now = new Date();
  await tx.insert(workItemIntegrationDeliveries).values([
    { integrationId: s.integrationId, deliveryId: "old", receivedAt: new Date(now.getTime() - 31 * 86_400_000) },
    { integrationId: s.integrationId, deliveryId: "recent", receivedAt: new Date(now.getTime() - 29 * 86_400_000) },
  ]);
  await purgeIntegrationDeliveries(tx, now);
  expect((await tx.select().from(workItemIntegrationDeliveries).where(eq(workItemIntegrationDeliveries.integrationId, s.integrationId))).map((row) => row.deliveryId)).toEqual(["recent"]);
}));
