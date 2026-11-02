import { afterAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { activities, createDatabase, type Database } from "@weft/db";
import { createAssetActions, createCommentActions, createProjectActions, createWikiActions, createWorkItemActions, signPostPolicy, type AssetStorage } from "../src";
import { createMemberFactory, createWorkspaceFactory, withRollback } from "../../db/src/test-helpers";

const { client, db } = createDatabase();
afterAll(async () => client.end());

/** In-memory object storage; `put` plays the browser's upload step. */
function memoryStorage() {
  const objects = new Map<string, number>();
  const storage: AssetStorage = {
    presignPost: ({ key, contentType, maxBytes }) => ({ url: "http://storage.test/bucket", fields: { key, "Content-Type": contentType, maxBytes: String(maxBytes) } }),
    head: async (key) => (objects.has(key) ? { size: objects.get(key)! } : null),
    remove: async (key) => { objects.delete(key); },
    copy: async (source, destination) => { const size = objects.get(source); if (size === undefined) throw new Error("missing source"); objects.set(destination, size); },
    presignGet: ({ key, inline, contentType, filename }) => ({ url: `http://storage.test/${key}?inline=${inline}&type=${encodeURIComponent(inline ? contentType : "application/octet-stream")}&name=${encodeURIComponent(filename)}` }),
  };
  return { storage, put: (key: string, size: number) => objects.set(key, size), objects };
}

async function setup(transaction: Database, limit = 5 * 1024 * 1024) {
  const workspace = await createWorkspaceFactory(transaction);
  const admin = await createMemberFactory(transaction, workspace.id, "Admin");
  const member = await createMemberFactory(transaction, workspace.id, "Member");
  const guest = await createMemberFactory(transaction, workspace.id, "Guest");
  const outsider = await createMemberFactory(transaction, workspace.id, "Member");
  const projects = createProjectActions(transaction);
  const project = await projects.createProject.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Secret", key: "SEC", visibility: "private" });
  for (const user of [member, guest]) await projects.addProjectMember.handler({ userId: admin.id }, { projectId: project.id, userId: user.id, role: user === guest ? "Guest" : "Member" });
  const item = await createWorkItemActions(transaction).createWorkItem.handler({ userId: member.id }, { projectId: project.id, title: "Item" });
  const mem = memoryStorage();
  return { workspace, admin, member, guest, outsider, item, project, mem, assets: createAssetActions(transaction, mem.storage, () => limit), comments: createCommentActions(transaction) };
}

async function upload(env: Awaited<ReturnType<typeof setup>>, userId: string, file: { filename: string; contentType: string; size: number }, owner?: { ownerType: "work_item" | "comment" | "wiki_page"; ownerId: string }) {
  const ticket = await env.assets.requestAssetUpload.handler({ userId }, { ...(owner ?? { ownerType: "work_item", ownerId: env.item.id }), ...file });
  env.mem.put(ticket.fields.key!, file.size);
  return env.assets.completeAssetUpload.handler({ userId }, { assetId: ticket.assetId });
}

test.concurrent("upload round trip: presigned POST, complete, list, activity written", async () => {
  await withRollback(db, async (transaction) => {
    const env = await setup(transaction);
    const ticket = await env.assets.requestAssetUpload.handler({ userId: env.member.id }, { ownerType: "work_item", ownerId: env.item.id, filename: "shot.png", contentType: "image/png", size: 1000 });
    expect(ticket.url).toBe("http://storage.test/bucket");
    expect(ticket.fields["Content-Type"]).toBe("image/png");
    expect(await env.assets.listAssets.handler({ userId: env.member.id }, { ownerType: "work_item", ownerId: env.item.id })).toEqual([]);
    await expect(env.assets.completeAssetUpload.handler({ userId: env.member.id }, { assetId: ticket.assetId })).rejects.toMatchObject({ status: 400 });
    env.mem.put(ticket.fields.key!, 1000);
    const done = await env.assets.completeAssetUpload.handler({ userId: env.member.id }, { assetId: ticket.assetId });
    expect(done).toMatchObject({ filename: "shot.png", size: 1000, inline: true, ownerType: "work_item", ownerId: env.item.id });
    const list = await env.assets.listAssets.handler({ userId: env.guest.id }, { ownerType: "work_item", ownerId: env.item.id });
    expect(list.map((row) => row.id)).toEqual([done.id]);
    const log = await transaction.select().from(activities).where(eq(activities.entityId, env.item.id));
    expect(log.some((row) => row.field === "attachment_added")).toBe(true);
  });
});

test.concurrent("asset is tied to one owner: a comment's asset lists under the comment only", async () => {
  await withRollback(db, async (transaction) => {
    const env = await setup(transaction);
    const comment = await env.comments.createComment.handler({ userId: env.member.id }, { workItemId: env.item.id, body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "see" }] }] } });
    const asset = await upload(env, env.member.id, { filename: "a.png", contentType: "image/png", size: 10 }, { ownerType: "comment", ownerId: comment.id });
    expect(await env.assets.listAssets.handler({ userId: env.member.id }, { ownerType: "comment", ownerId: comment.id })).toHaveLength(1);
    expect(await env.assets.listAssets.handler({ userId: env.member.id }, { ownerType: "work_item", ownerId: env.item.id })).toHaveLength(0);
    expect(asset.ownerType).toBe("comment");
    await expect(env.assets.requestAssetUpload.handler({ userId: env.member.id }, { ownerType: "comment", ownerId: crypto.randomUUID(), filename: "a", contentType: "image/png", size: 1 })).rejects.toMatchObject({ status: 404 });
  });
});

test.concurrent("size limit: oversize request rejected, limit configurable, oversize stored object purged on complete", async () => {
  await withRollback(db, async (transaction) => {
    const env = await setup(transaction, 100);
    await expect(env.assets.requestAssetUpload.handler({ userId: env.member.id }, { ownerType: "work_item", ownerId: env.item.id, filename: "big.png", contentType: "image/png", size: 101 })).rejects.toMatchObject({ status: 413 });
    const ticket = await env.assets.requestAssetUpload.handler({ userId: env.member.id }, { ownerType: "work_item", ownerId: env.item.id, filename: "ok.png", contentType: "image/png", size: 100 });
    expect(ticket.maxBytes).toBe(100);
    env.mem.put(ticket.fields.key!, 5000); // client lied about size
    await expect(env.assets.completeAssetUpload.handler({ userId: env.member.id }, { assetId: ticket.assetId })).rejects.toMatchObject({ status: 413 });
    expect(env.mem.objects.has(ticket.fields.key!)).toBe(false);
    expect(await env.assets.listAssets.handler({ userId: env.member.id }, { ownerType: "work_item", ownerId: env.item.id })).toEqual([]);
  });
});

test("default limit is 5 MB and ASSET_MAX_BYTES overrides it", async () => {
  const { maxAssetBytes } = await import("../src");
  expect(maxAssetBytes({})).toBe(5 * 1024 * 1024);
  expect(maxAssetBytes({ ASSET_MAX_BYTES: "1024" })).toBe(1024);
  expect(maxAssetBytes({ ASSET_MAX_BYTES: "junk" })).toBe(5 * 1024 * 1024);
});

test("presigned POST policy pins key, type and size range, and is deterministic SigV4", () => {
  const settings = { endpoint: "http://minio:9000", publicEndpoint: "http://localhost:9000", bucket: "b", region: "us-east-1", accessKeyId: "AK", secretAccessKey: "SK" };
  const now = new Date("2026-01-02T03:04:05Z");
  const post = signPostPolicy(settings, { key: "w/a", contentType: "image/png", maxBytes: 77 }, now);
  expect(post.url).toBe("http://localhost:9000/b");
  expect(post.fields["x-amz-date"]).toBe("20260102T030405Z");
  const policy = JSON.parse(Buffer.from(post.fields.policy!, "base64").toString());
  expect(policy.conditions).toContainEqual(["content-length-range", 1, 77]);
  expect(policy.conditions).toContainEqual({ key: "w/a" });
  expect(policy.conditions).toContainEqual({ "Content-Type": "image/png" });
  expect(post.fields["x-amz-signature"]).toMatch(/^[0-9a-f]{64}$/);
  expect(signPostPolicy(settings, { key: "w/a", contentType: "image/png", maxBytes: 77 }, now)).toEqual(post);
  expect(signPostPolicy(settings, { key: "w/a", contentType: "image/png", maxBytes: 78 }, now).fields["x-amz-signature"]).not.toBe(post.fields["x-amz-signature"]);
});

test.concurrent("png, jpeg, gif, webp render inline; svg, html and others download only", async () => {
  await withRollback(db, async (transaction) => {
    const env = await setup(transaction);
    const cases: Array<[string, string, boolean]> = [
      ["image/png", "a.png", true], ["image/jpeg", "a.jpg", true], ["image/gif", "a.gif", true], ["image/webp", "a.webp", true], ["IMAGE/PNG; charset=x", "b.png", true],
      ["image/svg+xml", "a.svg", false], ["text/html", "a.html", false], ["application/xhtml+xml", "a.xhtml", false], ["application/pdf", "a.pdf", false], ["", "none", false],
    ];
    for (const [contentType, filename, expected] of cases) {
      const ticket = await env.assets.requestAssetUpload.handler({ userId: env.member.id }, { ownerType: "work_item", ownerId: env.item.id, filename, contentType: contentType || "x", size: 10 });
      env.mem.put(ticket.fields.key!, 10);
      const asset = await env.assets.completeAssetUpload.handler({ userId: env.member.id }, { assetId: ticket.assetId });
      expect(asset.inline).toBe(expected);
      const download = await env.assets.getAssetDownloadUrl.handler({ userId: env.member.id }, { assetId: asset.id });
      expect(download.inline).toBe(expected);
      expect(download.url).toContain(`inline=${expected}`);
      if (!expected) expect(decodeURIComponent(download.url)).toContain("type=application/octet-stream");
    }
  });
});

test.concurrent("access control: download needs read access; upload and delete need write; guests and outsiders are denied", async () => {
  await withRollback(db, async (transaction) => {
    const env = await setup(transaction);
    const asset = await upload(env, env.member.id, { filename: "a.png", contentType: "image/png", size: 10 });
    expect((await env.assets.getAssetDownloadUrl.handler({ userId: env.guest.id }, { assetId: asset.id })).filename).toBe("a.png");
    expect((await env.assets.getAssetDownloadUrl.handler({ userId: env.admin.id }, { assetId: asset.id })).filename).toBe("a.png");
    await expect(env.assets.getAssetDownloadUrl.handler({ userId: env.outsider.id }, { assetId: asset.id })).rejects.toMatchObject({ status: 404 });
    await expect(env.assets.listAssets.handler({ userId: env.outsider.id }, { ownerType: "work_item", ownerId: env.item.id })).rejects.toMatchObject({ status: 404 });
    await expect(env.assets.requestAssetUpload.handler({ userId: env.guest.id }, { ownerType: "work_item", ownerId: env.item.id, filename: "a", contentType: "image/png", size: 1 })).rejects.toMatchObject({ status: 403 });
    await expect(env.assets.requestAssetUpload.handler({ userId: env.outsider.id }, { ownerType: "work_item", ownerId: env.item.id, filename: "a", contentType: "image/png", size: 1 })).rejects.toMatchObject({ status: 404 });
    await expect(env.assets.deleteAsset.handler({ userId: env.guest.id }, { assetId: asset.id })).rejects.toMatchObject({ status: 403 });
    const pending = await env.assets.requestAssetUpload.handler({ userId: env.member.id }, { ownerType: "work_item", ownerId: env.item.id, filename: "p", contentType: "image/png", size: 1 });
    await expect(env.assets.getAssetDownloadUrl.handler({ userId: env.member.id }, { assetId: pending.assetId })).rejects.toMatchObject({ status: 404 });
    await expect(env.assets.completeAssetUpload.handler({ userId: env.admin.id }, { assetId: pending.assetId })).rejects.toMatchObject({ status: 403 });
    await env.assets.deleteAsset.handler({ userId: env.admin.id }, { assetId: asset.id });
    await expect(env.assets.getAssetDownloadUrl.handler({ userId: env.member.id }, { assetId: asset.id })).rejects.toMatchObject({ status: 404 });
    expect(env.mem.objects.has(`${env.workspace.id}/${asset.id}`)).toBe(false);
  });
});

test.concurrent("wiki_page owner: public page open to members, guest reads only; private page owner only", async () => {
  await withRollback(db, async (transaction) => {
    const env = await setup(transaction);
    const wiki = createWikiActions(transaction);
    const pub = await wiki.createWikiPage.handler({ userId: env.member.id }, { workspaceId: env.workspace.id, title: "Public", access: "public" });
    const priv = await wiki.createWikiPage.handler({ userId: env.member.id }, { workspaceId: env.workspace.id, title: "Private", access: "private" });
    const owner = (id: string) => ({ ownerType: "wiki_page" as const, ownerId: id });
    const file = { filename: "a.png", contentType: "image/png", size: 10 };

    // Public: any non-guest member may attach (outsider is a Member of the workspace but not of the project), guest may only read.
    const asset = await upload(env, env.outsider.id, file, owner(pub.id));
    expect(asset).toMatchObject({ ownerType: "wiki_page", ownerId: pub.id, inline: true });
    expect((await env.assets.listAssets.handler({ userId: env.guest.id }, owner(pub.id))).map((row) => row.id)).toEqual([asset.id]);
    expect((await env.assets.getAssetDownloadUrl.handler({ userId: env.guest.id }, { assetId: asset.id })).inline).toBe(true);
    await expect(env.assets.requestAssetUpload.handler({ userId: env.guest.id }, { ...owner(pub.id), ...file })).rejects.toMatchObject({ status: 403 });
    // A Page image follows the Page's project write access.
    expect(await env.assets.deleteAsset.handler({ userId: env.member.id }, { assetId: asset.id })).toEqual({ ok: true });

    // Private: owner only; everyone else sees a missing page, even an admin.
    const own = await upload(env, env.member.id, file, owner(priv.id));
    expect(await env.assets.listAssets.handler({ userId: env.member.id }, owner(priv.id))).toHaveLength(1);
    for (const stranger of [env.outsider, env.guest, env.admin]) {
      await expect(env.assets.listAssets.handler({ userId: stranger.id }, owner(priv.id))).rejects.toMatchObject({ status: 404 });
      await expect(env.assets.requestAssetUpload.handler({ userId: stranger.id }, { ...owner(priv.id), ...file })).rejects.toMatchObject({ status: 404 });
      await expect(env.assets.getAssetDownloadUrl.handler({ userId: stranger.id }, { assetId: own.id })).rejects.toMatchObject({ status: 404 });
    }
    await expect(env.assets.requestAssetUpload.handler({ userId: env.member.id }, { ...owner(crypto.randomUUID()), ...file })).rejects.toMatchObject({ status: 404 });

    const projectPage = await wiki.createWikiPage.handler({ userId: env.member.id }, { workspaceId: env.workspace.id, projectId: env.project.id, title: "Project Page" });
    const projectImage = await upload(env, env.member.id, file, owner(projectPage.id));
    expect((await env.assets.listAssets.handler({ userId: env.guest.id }, owner(projectPage.id))).map((row) => row.id)).toEqual([projectImage.id]);
    await expect(env.assets.listAssets.handler({ userId: env.outsider.id }, owner(projectPage.id))).rejects.toMatchObject({ status: 404 });
    await expect(env.assets.getAssetDownloadUrl.handler({ userId: env.outsider.id }, { assetId: projectImage.id })).rejects.toMatchObject({ status: 404 });
    await expect(env.assets.requestAssetUpload.handler({ userId: env.guest.id }, { ...owner(projectPage.id), ...file })).rejects.toMatchObject({ status: 403 });
    const guestPage = await wiki.createWikiPage.handler({ userId: env.member.id }, { workspaceId: env.workspace.id, projectId: env.project.id, title: "Guest Page" });
    await expect(env.assets.requestAssetUpload.handler({ userId: env.guest.id }, { ...owner(guestPage.id), ...file })).rejects.toMatchObject({ status: 403 });
  });
});

test.concurrent("deleting an attachment writes an Activity on the work item, with the source", async () => {
  await withRollback(db, async (transaction) => {
    const env = await setup(transaction);
    const asset = await upload(env, env.member.id, { filename: "shot.png", contentType: "image/png", size: 1000 });
    await env.assets.deleteAsset.handler({ userId: env.member.id, source: "cli" }, { assetId: asset.id });
    const removed = (await transaction.select().from(activities).where(eq(activities.entityId, env.item.id))).filter((row) => row.field === "attachment_removed");
    expect(removed).toHaveLength(1);
    expect(removed[0]).toMatchObject({ actorId: env.member.id, source: "cli", newValue: null });
    expect(removed[0]!.oldValue).toMatchObject({ assetId: asset.id, filename: "shot.png" });
  });
});

test.concurrent("assets on a wiki page comment follow the wiki page access, and generic comment actions do not reach it", async () => {
  await withRollback(db, async (transaction) => {
    const env = await setup(transaction);
    const wiki = createWikiActions(transaction);
    const page = await wiki.createWikiPage.handler({ userId: env.member.id }, { workspaceId: env.workspace.id, title: "Private", access: "private" });
    const comment = await wiki.createWikiPageComment.handler({ userId: env.member.id }, { pageId: page.id, anchor: "a", body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "note" }] }] } }) as { id: string };
    const file = { filename: "a.png", contentType: "image/png", size: 10 };
    await expect(env.assets.requestAssetUpload.handler({ userId: env.outsider.id }, { ownerType: "comment", ownerId: comment.id, ...file })).rejects.toMatchObject({ status: 404 });
    await expect(upload(env, env.member.id, file, { ownerType: "comment", ownerId: comment.id })).resolves.toMatchObject({ ownerType: "comment" });
    await expect(env.comments.updateComment.handler({ userId: env.member.id }, { commentId: comment.id, body: { type: "doc", content: [] } })).rejects.toMatchObject({ status: 404 });
  });
});
