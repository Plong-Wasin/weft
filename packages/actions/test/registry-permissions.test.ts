import { afterAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createDatabase, assets, workspaceInvites, type Database } from "@weft/db";
import { ActionError, createActionList, createCommentActions, createMemberActions, createSearchActions, createProjectActions, createRelationActions, createWikiActions, createWorkItemActions } from "../src";
import { createMemberFactory, createUserFactory, createWorkspaceFactory, withRollback } from "../../db/src/test-helpers";

const { client, db } = createDatabase();
afterAll(async () => client.end());

/**
 * Registry-wide guard (ADR 0001): the REST routes, AI tools, MCP tools and CLI are all derived from the
 * Action list, so a new Action that forgets its permission check would be exposed everywhere. This calls
 * every Action as someone who must not be allowed and expects a 403 or 404.
 *
 * Not covered here: `create_workspace` and `hello` (not in the Action list), the own-data Actions below, `accept_invite`,
 * and the route, AI-tool, MCP and CLI layers on top of the list.
 */

/** Actions that only touch the caller's own data, so they legitimately succeed for any signed-in user. */
const ownDataActions = new Set(["create_api_token", "list_api_tokens", "revoke_api_token", "get_my_locale", "set_my_locale", "list_notifications", "mark_notification_read", "mark_all_notifications_read", "unread_notification_count"]);
/** Succeeds or fails on a bearer secret rather than on membership. */
const bearerSecretActions = new Set(["accept_invite"]);

type Schema = { type?: string; properties?: Record<string, Schema>; required?: string[]; anyOf?: Schema[]; const?: unknown; format?: string; items?: Schema; enum?: unknown[] };

function sample(name: string, schema: Schema, ids: Record<string, unknown>): unknown {
  if (name in ids) return ids[name];
  if (schema.const !== undefined) return schema.const;
  if (schema.enum) return schema.enum[0];
  if (schema.anyOf) return sample(name, schema.anyOf.find((option) => option.type !== "null") ?? schema.anyOf[0]!, ids);
  switch (schema.type) {
    case "string": return schema.format === "uuid" ? crypto.randomUUID() : name === "key" ? "ZZ" : "x";
    case "integer": case "number": return 1;
    case "boolean": return false;
    case "array": return [];
    case "object": return {};
    default: return null;
  }
}

function inputFor(schema: Schema, ids: Record<string, unknown>) {
  const input: Record<string, unknown> = {};
  for (const name of schema.required ?? []) input[name] = sample(name, schema.properties![name]!, ids);
  return input;
}

async function fixture(transaction: Database) {
  const workspace = await createWorkspaceFactory(transaction);
  const admin = await createMemberFactory(transaction, workspace.id, "Admin");
  const guest = await createMemberFactory(transaction, workspace.id, "Guest");
  const stranger = await createUserFactory(transaction);
  const member = await createMemberFactory(transaction, workspace.id, "Member");
  const projects = createProjectActions(transaction);
  const project = await projects.createProject.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Secret", key: "SEC", visibility: "private" });
  await projects.addProjectMember.handler({ userId: admin.id }, { projectId: project.id, userId: guest.id, role: "Guest" });
  const work = createWorkItemActions(transaction);
  const item = await work.createWorkItem.handler({ userId: admin.id }, { projectId: project.id, title: "Item" });
  const related = await work.createWorkItem.handler({ userId: admin.id }, { projectId: project.id, title: "Related" });
  await createRelationActions(transaction).createWorkItemRelation.handler({ userId: admin.id }, { workItemId: item.id, relatedWorkItemId: related.id, type: "relates_to" });
  const label = await work.createLabel.handler({ userId: admin.id }, { projectId: project.id, name: "bug" } as never);
  const states = await work.listStates.handler({ userId: admin.id }, { projectId: project.id });
  const comment = await createCommentActions(transaction).createComment.handler({ userId: admin.id }, { workItemId: item.id, body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }] } } as never);
  const wiki = createWikiActions(transaction);
  const page = await wiki.createWikiPage.handler({ userId: admin.id }, { workspaceId: workspace.id, title: "Private", access: "private" });
  const [version] = await wiki.listWikiPageVersions.handler({ userId: admin.id }, { pageId: page.id });
  const [asset] = await transaction.insert(assets).values({
    workspaceId: workspace.id, projectId: project.id, ownerType: "work_item", ownerId: item.id, uploaderId: admin.id,
    storageKey: `${workspace.id}/x`, filename: "x.png", contentType: "image/png", size: 1, status: "uploaded",
  }).returning();
  await createMemberActions(transaction).createInvite.handler({ userId: admin.id }, { workspaceId: workspace.id, role: "Member" });
  const [inviteRow] = await transaction.select().from(workspaceInvites).where(eq(workspaceInvites.workspaceId, workspace.id));
  const ids = {
    inviteId: inviteRow!.id, workspaceId: workspace.id, projectId: project.id, workItemId: item.id, relatedWorkItemId: related.id, commentId: comment.id, labelId: label.id, stateId: states[0]!.id,
    pageId: page.id, versionId: version!.id, assetId: asset!.id, ownerType: "work_item", ownerId: item.id, userId: admin.id,
    key: "SEC", displayId: "SEC-1", parentId: null, body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "probe" }] }] },
  };
  return { admin, guest, member, stranger, ids };
}

const denied = (error: unknown) => error instanceof ActionError && (error.status === 403 || error.status === 404);

type Probe = { name: string; result: string };

/** Calls every selected Action as `userId`; each result is "denied" (403/404), "allowed", or "error:<message>". */
async function probe(transaction: Database, userId: string, ids: Record<string, unknown>, only: (action: { kind: string; name: string; input: unknown }) => boolean): Promise<Probe[]> {
  const probes: Probe[] = [];
  for (const action of createActionList(transaction).filter(only)) {
    if (ownDataActions.has(action.name) || bearerSecretActions.has(action.name)) continue;
    const input = inputFor(action.input as unknown as Schema, ids);
    // A savepoint keeps one failing statement from poisoning the shared transaction.
    await transaction.execute("savepoint probe" as never).catch(() => null);
    const result = await (action.handler as (context: { userId: string }, input: unknown) => Promise<unknown>)({ userId }, input).then(() => "allowed", (error: unknown) => (denied(error) ? "denied" : `error:${(error as Error).message}`));
    await transaction.execute("rollback to savepoint probe" as never).catch(() => null);
    probes.push({ name: action.name, result });
  }
  return probes;
}
const notDenied = (probes: Probe[]) => probes.filter((entry) => entry.result !== "denied").map((entry) => `${entry.name} -> ${entry.result}`);
/** Actions whose input names something inside a private project or a private wiki page, so a plain workspace Member must not reach them. */
/** Open to any workspace Member on purpose (a Member may create a project), so it is not "aimed at" a private project. */
const workspaceLevel = new Set(["create_project"]);
const scoped = (action: { name: string; input: unknown }) => !workspaceLevel.has(action.name) && ((action.input as Schema).required ?? []).some((name) => ["projectId", "workItemId", "commentId", "labelId", "stateId", "assetId", "ownerId", "key", "displayId", "pageId", "versionId"].includes(name));

test.concurrent("sanity: with these inputs a workspace Admin reaches past the permission gate on every Action (no 403/404)", async () => {
  await withRollback(db, async (transaction) => {
    const { admin, ids } = await fixture(transaction);
    // If an Action answered 404 to an Admin, the probes below would be "denied" for the wrong reason (bad input), proving nothing.
    const refused = (await probe(transaction, admin.id, ids, () => true)).filter((entry) => entry.result === "denied").map((entry) => entry.name);
    // join_project is refused to everyone for a private project, Admin included: a business rule, not a gate.
    expect(refused).toEqual(["join_project"]);
  });
});

test.concurrent("a signed-in user with no membership is denied by every Action that is not about their own data", async () => {
  await withRollback(db, async (transaction) => {
    const { stranger, ids } = await fixture(transaction);
    expect(notDenied(await probe(transaction, stranger.id, ids, () => true))).toEqual([]);
  });
});

test.concurrent("a workspace Member outside the private project and not the page owner is denied by every Action that names that project or page", async () => {
  await withRollback(db, async (transaction) => {
    const { member, ids } = await fixture(transaction);
    const probes = await probe(transaction, member.id, ids, scoped);
    expect(probes.length).toBeGreaterThan(30);
    expect(notDenied(probes)).toEqual([]);
  });
});

test.concurrent("a Guest is denied by every Write action that is not about their own data", async () => {
  await withRollback(db, async (transaction) => {
    const { guest, ids } = await fixture(transaction);
    expect(notDenied(await probe(transaction, guest.id, ids, (action) => action.kind === "write"))).toEqual([]);
  });
});

test.concurrent("list and search Actions never show a private project, work item, or wiki page to people who cannot see them", async () => {
  await withRollback(db, async (transaction) => {
    const { admin, member, ids } = await fixture(transaction);
    const outsideGuest = await createMemberFactory(transaction, ids.workspaceId as string, "Guest");
    const projects = createProjectActions(transaction);
    const search = createSearchActions(transaction);
    const wiki = createWikiActions(transaction);
    const seen = async (userId: string) => ({
      projects: (await projects.listProjects.handler({ userId }, { workspaceId: ids.workspaceId as string })).map((row) => row.key),
      items: (await search.searchWorkItems.handler({ userId }, { workspaceId: ids.workspaceId as string, query: "Item" })).length,
      pages: (await wiki.listWikiPages.handler({ userId }, { workspaceId: ids.workspaceId as string })).length,
      pageHits: (await wiki.searchWikiPages.handler({ userId }, { workspaceId: ids.workspaceId as string, query: "Private" })).length,
    });
    // Control: the Admin who owns all of it does see it, so an empty answer below means filtered, not "nothing exists".
    expect(await seen(admin.id)).toEqual({ projects: ["SEC"], items: 1, pages: 1, pageHits: 1 });
    for (const outsider of [member, outsideGuest]) expect(await seen(outsider.id)).toEqual({ projects: [], items: 0, pages: 0, pageHits: 0 });
  });
});

test.concurrent("a Member is denied the admin-only member actions", async () => {
  await withRollback(db, async (transaction) => {
    const { admin, member, ids } = await fixture(transaction);
    const members = createMemberActions(transaction);
    const workspaceId = ids.workspaceId as string;
    const refusals = await Promise.all([
      members.createInvite.handler({ userId: member.id }, { workspaceId, role: "Admin" }).then(() => 200, (error: ActionError) => error.status),
      members.changeMemberRole.handler({ userId: member.id }, { workspaceId, userId: member.id, role: "Admin" }).then(() => 200, (error: ActionError) => error.status),
      members.removeMember.handler({ userId: member.id }, { workspaceId, userId: admin.id }).then(() => 200, (error: ActionError) => error.status),
    ]);
    expect(refusals).toEqual([403, 403, 403]);
  });
});
