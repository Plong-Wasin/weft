import { afterAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { activities, apiTokens, assets as assetTable, createDatabase, daemons, intakeItems, notifications, runs, runtimes, workspaces, type Database } from "@weft/db";
import { createAssetActions, createCommentActions, createIntakeActions, createProjectActions, createWikiActions, createWorkItemActions, signPostPolicy, type AssetStorage } from "../src";
import { createMemberFactory, createWorkspaceFactory, withRollback } from "../../db/src/test-helpers";
import { sealSecret } from "../src/integration-secrets";

test("secret inspection recognizes text and HTML while refusing to call unsupported documents clean", async () => {
  const { inspectAssetBytes } = await import("../src/assets");
  expect(inspectAssetBytes("text/plain", Buffer.from("value=top-secret"), ["top-secret"])).toEqual({ status: "secret" });
  expect(inspectAssetBytes("text/html", Buffer.from("<p>top-secret</p>"), ["top-secret"])).toEqual({ status: "secret" });
  for (const encoding of ["base64", "base64url", "hex"] as const) {
    expect(inspectAssetBytes("text/plain", Buffer.from(`payload=${Buffer.from("top-secret").toString(encoding)}`), ["top-secret"])).toEqual({ status: "secret" });
  }
  expect(inspectAssetBytes("application/pdf", Buffer.from("%PDF-1.7"), ["top-secret"])).toEqual({ status: "unverified" });
  expect(inspectAssetBytes("text/plain", Buffer.from("%PDF-1.7 hidden"), ["top-secret"])).toEqual({ status: "unverified" });
  expect(inspectAssetBytes("text/plain", Buffer.from([0xff, 0xfe]), ["top-secret"])).toEqual({ status: "unverified" });
  expect(inspectAssetBytes("text/plain", Buffer.from("hello"), ["top-secret"])).toEqual({ status: "clean" });
});

test.concurrent("Agent secret attachment is withheld, its partial object is removed, and retry error hides the value", async () => {
  await withRollback(db, async (transaction) => {
    const env = await setup(transaction);
    const runId = crypto.randomUUID();
    const [token] = await transaction.insert(apiTokens).values({ userId: env.admin.id, name: "Runtime", tokenHash: crypto.randomUUID(), tokenPrefix: "test", daemonOnly: true }).returning();
    const [daemon] = await transaction.insert(daemons).values({ ownerId: env.admin.id, hostname: "test-host", tokenId: token!.id, version: "test" }).returning();
    const [runtime] = await transaction.insert(runtimes).values({ workspaceId: env.workspace.id, daemonId: daemon!.id, ownerId: env.admin.id, agentCli: "codex", shared: true }).returning();
    await transaction.insert(runs).values({ id: runId, workspaceId: env.workspace.id, projectId: env.project.id, workItemId: env.item.id, agentId: null, originatorId: env.member.id, runtimeId: runtime!.id, status: "running", runtimeEnvironmentSecrets: sealSecret(JSON.stringify({ API_TOKEN: "hidden-value-928" })) });
    const context = { userId: env.member.id, agent: { agentUserId: env.guest.id, runId, originatorId: env.member.id, workspaceId: env.workspace.id } };
    const ticket = await env.assets.requestAssetUpload.handler(context, { ownerType: "work_item", ownerId: env.item.id, filename: "report.txt", contentType: "text/plain", size: 35 });
    env.mem.putBytes(ticket.fields.key!, new TextEncoder().encode("result: hidden-value-928"));
    let failure: Error | undefined;
    try { await env.assets.completeAssetUpload.handler(context, { assetId: ticket.assetId }); } catch (error) { failure = error as Error; }
    expect(failure?.message).toContain("retry with a safe file");
    expect(failure?.message).not.toContain("hidden-value-928");
    expect(env.mem.objects.has(ticket.fields.key!)).toBe(false);
    expect(await env.assets.listAssets.handler({ userId: env.member.id }, { ownerType: "work_item", ownerId: env.item.id })).toEqual([]);
    const notices = await transaction.select({ kind: notifications.kind, detail: notifications.detail, workItemId: notifications.workItemId, userId: notifications.userId }).from(notifications);
    expect(notices).toHaveLength(2);
    expect(notices.every((notice) => notice.kind === "secret_output_blocked" && notice.detail === null && notice.workItemId === null)).toBe(true);
    expect(new Set(notices.map((notice) => notice.userId))).toEqual(new Set([env.member.id, env.admin.id]));
    const retry = await env.assets.requestAssetUpload.handler(context, { ownerType: "work_item", ownerId: env.item.id, filename: "safe.txt", contentType: "text/plain", size: 12 });
    env.mem.putBytes(retry.fields.key!, new TextEncoder().encode("safe output"));
    expect(await env.assets.completeAssetUpload.handler(context, { assetId: retry.assetId })).toMatchObject({ filename: "safe.txt", unverified: false });
  });
});

test.concurrent("reusing a still-valid upload URL cannot replace the exact bytes inspected and published", async () => {
  await withRollback(db, async (transaction) => {
    const env = await setup(transaction);
    const runId = crypto.randomUUID();
    await transaction.insert(runs).values({ id: runId, workspaceId: env.workspace.id, projectId: env.project.id, workItemId: env.item.id, originatorId: env.member.id, status: "running", runtimeEnvironmentSecrets: sealSecret(JSON.stringify({ API_TOKEN: "late-secret-772" })) });
    const context = { userId: env.member.id, agent: { agentUserId: env.guest.id, runId, originatorId: env.member.id, workspaceId: env.workspace.id } };
    const ticket = await env.assets.requestAssetUpload.handler(context, { ownerType: "work_item", ownerId: env.item.id, filename: "result.txt", contentType: "text/plain", size: 11 });
    env.mem.putBytes(ticket.fields.key!, new TextEncoder().encode("safe result"));
    const published = await env.assets.completeAssetUpload.handler(context, { assetId: ticket.assetId });
    const [row] = await transaction.select().from(assetTable).where(eq(assetTable.id, published.id));
    const approvedBytes = env.mem.objects.get(row!.storageKey)!;
    env.mem.putBytes(ticket.fields.key!, new TextEncoder().encode("late-secret-772"));
    expect(row!.storageKey).not.toBe(ticket.fields.key);
    expect(new TextDecoder().decode(env.mem.objects.get(row!.storageKey))).toBe("safe result");
    expect(new TextDecoder().decode(approvedBytes)).toBe("safe result");
    const download = await env.assets.getAssetDownloadUrl.handler({ userId: env.member.id }, { assetId: published.id });
    expect(decodeURIComponent(new URL(download.url).pathname.slice(1))).toBe(row!.storageKey);
    expect(new TextDecoder().decode(env.mem.objects.get(decodeURIComponent(new URL(download.url).pathname.slice(1))))).toBe("safe result");
  });
});

test.concurrent("failed publication removes the partial destination and leaves a cancellable pending upload", async () => {
  await withRollback(db, async (transaction) => {
    const env = await setup(transaction);
    const ticket = await env.assets.requestAssetUpload.handler({ userId: env.member.id }, { ownerType: "work_item", ownerId: env.item.id, filename: "retry.txt", contentType: "text/plain", size: 5 });
    env.mem.putBytes(ticket.fields.key!, new TextEncoder().encode("retry"));
    const originalPut = env.mem.storage.put;
    env.mem.storage.put = async (key, body) => {
      await originalPut(key, body, "text/plain");
      throw new Error("storage interrupted after partial write");
    };
    await expect(env.assets.completeAssetUpload.handler({ userId: env.member.id }, { assetId: ticket.assetId })).rejects.toMatchObject({ status: 500 });
    const [pending] = await transaction.select().from(assetTable).where(eq(assetTable.id, ticket.assetId));
    expect(pending?.status).toBe("pending");
    expect([...env.mem.objects.keys()].filter((key) => key.includes(`/assets/${ticket.assetId}/`))).toEqual([]);
    expect(env.mem.objects.has(ticket.fields.key!)).toBe(true);
    await env.assets.cancelAssetUpload.handler({ userId: env.member.id }, { assetId: ticket.assetId });
    expect(env.mem.objects.has(ticket.fields.key!)).toBe(false);
    env.mem.storage.put = originalPut;
  });
});

test.concurrent("Agent document and undecodable uploads are delivered with a persistent unverified state", async () => {
  await withRollback(db, async (transaction) => {
    const env = await setup(transaction);
    const runId = crypto.randomUUID();
    await transaction.insert(runs).values({ id: runId, workspaceId: env.workspace.id, projectId: env.project.id, workItemId: env.item.id, originatorId: env.member.id, status: "running" });
    const context = { userId: env.member.id, agent: { agentUserId: env.admin.id, runId, originatorId: env.member.id, workspaceId: env.workspace.id } };
    for (const [filename, contentType, bytes] of [["manual.pdf", "application/pdf", new TextEncoder().encode("%PDF-1.7 encrypted")], ["manual.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", new Uint8Array([0x50, 0x4b, 0x03, 0x04])], ["broken.txt", "text/plain", new Uint8Array([0xff, 0xfe])], ["inline.png", "image/png", new Uint8Array([0x89, 0x50, 0x4e, 0x47])]] as const) {
      const ticket = await env.assets.requestAssetUpload.handler(context, { ownerType: "work_item", ownerId: env.item.id, filename, contentType, size: bytes.byteLength });
      env.mem.putBytes(ticket.fields.key!, bytes);
      expect(await env.assets.completeAssetUpload.handler(context, { assetId: ticket.assetId })).toMatchObject({ filename, unverified: true });
      if (filename === "inline.png") expect(await env.assets.getAssetDownloadUrl.handler({ userId: env.member.id }, { assetId: ticket.assetId })).toMatchObject({ inline: true, unverified: true });
    }
    expect((await env.assets.listAssets.handler({ userId: env.member.id }, { ownerType: "work_item", ownerId: env.item.id })).map((asset) => asset.unverified)).toEqual([true, true, true, true]);
  });
});

const { client, db } = createDatabase();
afterAll(async () => client.end());

/** In-memory object storage; `put` plays the browser's upload step. */
function memoryStorage() {
  const objects = new Map<string, Uint8Array>();
  const storage: AssetStorage = {
    presignPost: ({ key, contentType, maxBytes }) => ({ url: "http://storage.test/bucket", fields: { key, "Content-Type": contentType, maxBytes: String(maxBytes) } }),
    head: async (key) => (objects.has(key) ? { size: objects.get(key)!.byteLength } : null),
    read: async (key) => objects.get(key)!,
    put: async (key, body) => { objects.set(key, typeof body === "string" ? new TextEncoder().encode(body) : new Uint8Array(body)); },
    remove: async (key) => { objects.delete(key); },
    copy: async (source, destination) => { const bytes = objects.get(source); if (bytes === undefined) throw new Error("missing source"); objects.set(destination, bytes); },
    presignGet: ({ key, inline, contentType, filename }) => ({ url: `http://storage.test/${key}?inline=${inline}&type=${encodeURIComponent(inline ? contentType : "application/octet-stream")}&name=${encodeURIComponent(filename)}` }),
  };
  return { storage, put: (key: string, size: number) => objects.set(key, new Uint8Array(size)), putBytes: (key: string, bytes: Uint8Array) => objects.set(key, bytes), objects };
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

test.concurrent("Intake assets allow the Guest submitter and Admin, preserve Guest isolation, and freeze on rejection", async () => {
  await withRollback(db, async (transaction) => {
    const env = await setup(transaction);
    const otherGuest = await createMemberFactory(transaction, env.workspace.id, "Guest");
    await createProjectActions(transaction).addProjectMember.handler({ userId: env.admin.id }, { projectId: env.project.id, userId: otherGuest.id, role: "Guest" });
    const intake = createIntakeActions(transaction);
    const item = await intake.submitIntakeItem.handler({ userId: env.guest.id }, { projectId: env.project.id, title: "Guest request" });
    const file = { filename: "evidence.png", contentType: "image/png", size: 10 };
    const asset = await upload(env, env.guest.id, file, { ownerType: "work_item", ownerId: item.workItemId });
    const timeline = await createWorkItemActions(transaction).listWorkItemActivities.handler({ userId: env.guest.id }, { workItemId: item.workItemId });
    expect(timeline.some((row) => row.field === "attachment_added" && (row.newValue as { filename?: string }).filename === file.filename)).toBe(true);
    await expect(createWorkItemActions(transaction).listWorkItemActivities.handler({ userId: otherGuest.id }, { workItemId: item.workItemId })).rejects.toMatchObject({ status: 403 });
    expect((await env.assets.listAssets.handler({ userId: env.member.id }, { ownerType: "work_item", ownerId: item.workItemId })).map((row) => row.id)).toEqual([asset.id]);
    await expect(env.assets.listAssets.handler({ userId: otherGuest.id }, { ownerType: "work_item", ownerId: item.workItemId })).rejects.toMatchObject({ status: 404 });
    await expect(env.assets.getAssetDownloadUrl.handler({ userId: otherGuest.id }, { assetId: asset.id })).rejects.toMatchObject({ status: 404 });
    await expect(env.assets.requestAssetUpload.handler({ userId: otherGuest.id }, { ownerType: "work_item", ownerId: item.workItemId, ...file })).rejects.toMatchObject({ status: 403 });
    await expect(env.assets.deleteAsset.handler({ userId: otherGuest.id }, { assetId: asset.id })).rejects.toMatchObject({ status: 403 });
    const adminManaged = await upload(env, env.guest.id, file, { ownerType: "work_item", ownerId: item.workItemId });
    await env.assets.deleteAsset.handler({ userId: env.admin.id }, { assetId: adminManaged.id });
    await env.assets.deleteAsset.handler({ userId: env.guest.id }, { assetId: asset.id });
    const abandoned = await env.assets.requestAssetUpload.handler({ userId: env.guest.id }, { ownerType: "work_item", ownerId: item.workItemId, ...file });
    env.mem.put(abandoned.fields.key!, 3);
    expect(await env.assets.cancelAssetUpload.handler({ userId: env.guest.id }, { assetId: abandoned.assetId })).toEqual({ ok: true });
    const second = await upload(env, env.guest.id, file, { ownerType: "work_item", ownerId: item.workItemId });
    await intake.rejectIntakeItem.handler({ userId: env.member.id }, { intakeItemId: item.id });
    expect(await env.assets.listAssets.handler({ userId: env.guest.id }, { ownerType: "work_item", ownerId: item.workItemId })).toHaveLength(1);
    await expect(env.assets.requestAssetUpload.handler({ userId: env.guest.id }, { ownerType: "work_item", ownerId: item.workItemId, ...file })).rejects.toMatchObject({ status: 400 });
    await expect(env.assets.deleteAsset.handler({ userId: env.guest.id }, { assetId: second.id })).rejects.toMatchObject({ status: 400 });
    await expect(env.assets.deleteAsset.handler({ userId: env.admin.id }, { assetId: second.id })).rejects.toMatchObject({ status: 400 });

    const duplicateItem = await intake.submitIntakeItem.handler({ userId: env.guest.id }, { projectId: env.project.id, title: "Duplicate guest request" });
    const duplicateAsset = await upload(env, env.guest.id, file, { ownerType: "work_item", ownerId: duplicateItem.workItemId });
    await intake.duplicateIntakeItem.handler({ userId: env.member.id }, { intakeItemId: duplicateItem.id, duplicateTo: env.item.id });
    expect(await env.assets.listAssets.handler({ userId: env.guest.id }, { ownerType: "work_item", ownerId: duplicateItem.workItemId })).toHaveLength(1);
    await expect(env.assets.requestAssetUpload.handler({ userId: env.admin.id }, { ownerType: "work_item", ownerId: duplicateItem.workItemId, ...file })).rejects.toMatchObject({ status: 400 });
    await expect(env.assets.deleteAsset.handler({ userId: env.admin.id }, { assetId: duplicateAsset.id })).rejects.toMatchObject({ status: 400 });

    const acceptedItem = await intake.submitIntakeItem.handler({ userId: env.guest.id }, { projectId: env.project.id, title: "Accepted guest request" });
    const acceptedAsset = await upload(env, env.guest.id, file, { ownerType: "work_item", ownerId: acceptedItem.workItemId });
    const document = { type: "doc", content: [{ type: "assetImage", attrs: { assetId: acceptedAsset.id, alt: "Proof" } }] };
    await intake.updateIntakeItem.handler({ userId: env.guest.id }, { intakeItemId: acceptedItem.id, description: document });
    expect((await intake.listIntakeItems.handler({ userId: env.member.id }, { projectId: env.project.id, outcome: "pending" })).find((row) => row.id === acceptedItem.id)?.descriptionMarkdown).toContain(`asset:${acceptedAsset.id}`);
    await intake.acceptIntakeItem.handler({ userId: env.member.id }, { intakeItemId: acceptedItem.id });
    expect((await env.assets.listAssets.handler({ userId: env.guest.id }, { ownerType: "work_item", ownerId: acceptedItem.workItemId })).map((row) => row.id)).toEqual([acceptedAsset.id]);
    expect((await env.assets.getAssetDownloadUrl.handler({ userId: env.guest.id }, { assetId: acceptedAsset.id })).filename).toBe(file.filename);
  });
});

test.concurrent("workspace Admin retains Intake asset, discussion and Activity access with a project Guest role", async () => {
  await withRollback(db, async (transaction) => {
    const env = await setup(transaction);
    await createProjectActions(transaction).addProjectMember.handler({ userId: env.admin.id }, { projectId: env.project.id, userId: env.admin.id, role: "Guest" });
    const intake = await createIntakeActions(transaction).submitIntakeItem.handler({ userId: env.guest.id }, { projectId: env.project.id, title: "Guest request" });
    const asset = await upload(env, env.guest.id, { filename: "proof.png", contentType: "image/png", size: 10 }, { ownerType: "work_item", ownerId: intake.workItemId });
    expect((await env.assets.listAssets.handler({ userId: env.admin.id }, { ownerType: "work_item", ownerId: intake.workItemId })).map((row) => row.id)).toEqual([asset.id]);
    expect((await env.assets.getAssetDownloadUrl.handler({ userId: env.admin.id }, { assetId: asset.id })).filename).toBe("proof.png");
    await env.comments.createComment.handler({ userId: env.admin.id }, { workItemId: intake.workItemId, body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Review" }] }] } });
    expect(await env.comments.listComments.handler({ userId: env.admin.id }, { workItemId: intake.workItemId })).toHaveLength(1);
    expect((await createWorkItemActions(transaction).listWorkItemActivities.handler({ userId: env.admin.id }, { workItemId: intake.workItemId })).length).toBeGreaterThan(0);
  });
});

test.concurrent("failed upload cancellation removes the pending row and stored object", async () => {
  await withRollback(db, async (transaction) => {
    const env = await setup(transaction);
    const ticket = await env.assets.requestAssetUpload.handler({ userId: env.member.id }, { ownerType: "work_item", ownerId: env.item.id, filename: "partial.bin", contentType: "application/octet-stream", size: 10 });
    env.mem.put(ticket.fields.key!, 4);
    expect(await env.assets.cancelAssetUpload.handler({ userId: env.member.id }, { assetId: ticket.assetId })).toEqual({ ok: true });
    expect(env.mem.objects.has(ticket.fields.key!)).toBe(false);
    expect(await transaction.select().from(assetTable).where(eq(assetTable.id, ticket.assetId))).toHaveLength(0);
  });
});

test("cancellation and completion serialize before changing stored bytes", async () => {
  // Separate committed transactions are needed to exercise the row lock.
  const env = await setup(db);
  try {
    const ticket = await env.assets.requestAssetUpload.handler({ userId: env.member.id }, { ownerType: "work_item", ownerId: env.item.id, filename: "race.png", contentType: "image/png", size: 10 });
    env.mem.put(ticket.fields.key!, 10);
    let releaseHead!: () => void;
    let enteredHead!: () => void;
    const entered = new Promise<void>((resolve) => { enteredHead = resolve; });
    const gate = new Promise<void>((resolve) => { releaseHead = resolve; });
    const originalHead = env.mem.storage.head;
    env.mem.storage.head = async (key) => { enteredHead(); await gate; return originalHead(key); };
    const completing = env.assets.completeAssetUpload.handler({ userId: env.member.id }, { assetId: ticket.assetId });
    await entered;
    let cancelled = false;
    const cancelling = env.assets.cancelAssetUpload.handler({ userId: env.member.id }, { assetId: ticket.assetId }).then(() => null, (error) => error).finally(() => { cancelled = true; });
    await Bun.sleep(100);
    expect(cancelled).toBe(false);
    expect(env.mem.objects.has(ticket.fields.key!)).toBe(true);
    releaseHead();
    expect((await completing).id).toBe(ticket.assetId);
    expect(await cancelling).toMatchObject({ status: 404 });
    expect(env.mem.objects.has(ticket.fields.key!)).toBe(false);
    const [completed] = await db.select().from(assetTable).where(eq(assetTable.id, ticket.assetId));
    expect(completed?.status).toBe("uploaded");
    expect(env.mem.objects.has(completed!.storageKey)).toBe(true);
  } finally {
    await db.delete(workspaces).where(eq(workspaces.id, env.workspace.id));
  }
});

test("upload completion observes a concurrent Intake decision before changing assets", async () => {
  const env = await setup(db);
  try {
    const item = await createIntakeActions(db).submitIntakeItem.handler({ userId: env.guest.id }, { projectId: env.project.id, title: "Request" });
    const ticket = await env.assets.requestAssetUpload.handler({ userId: env.guest.id }, { ownerType: "work_item", ownerId: item.workItemId, filename: "race.png", contentType: "image/png", size: 10 });
    env.mem.put(ticket.fields.key!, 10);
    let releaseDecision!: () => void;
    let decisionLocked!: () => void;
    const locked = new Promise<void>((resolve) => { decisionLocked = resolve; });
    const gate = new Promise<void>((resolve) => { releaseDecision = resolve; });
    const decision = db.transaction(async (transaction) => {
      await transaction.update(intakeItems).set({ outcome: "rejected" }).where(eq(intakeItems.id, item.id));
      decisionLocked();
      await gate;
    });
    await locked;
    let settled = false;
    const completing = env.assets.completeAssetUpload.handler({ userId: env.guest.id }, { assetId: ticket.assetId }).then(() => null, (error) => error).finally(() => { settled = true; });
    await Bun.sleep(100);
    expect(settled).toBe(false);
    releaseDecision();
    await decision;
    expect(await completing).toMatchObject({ status: 400 });
    expect((await db.select().from(assetTable).where(eq(assetTable.id, ticket.assetId)))[0]?.status).toBe("pending");
    expect((await db.select().from(activities).where(eq(activities.entityId, item.workItemId))).some((row) => row.field === "attachment_added")).toBe(false);
    await env.assets.cancelAssetUpload.handler({ userId: env.guest.id }, { assetId: ticket.assetId });
  } finally {
    await db.delete(workspaces).where(eq(workspaces.id, env.workspace.id));
  }
});

test("attachment deletion observes a concurrent Intake decision", async () => {
  const env = await setup(db);
  try {
    const item = await createIntakeActions(db).submitIntakeItem.handler({ userId: env.guest.id }, { projectId: env.project.id, title: "Request" });
    const asset = await upload(env, env.guest.id, { filename: "race.png", contentType: "image/png", size: 10 }, { ownerType: "work_item", ownerId: item.workItemId });
    let release!: () => void;
    let signal!: () => void;
    const locked = new Promise<void>((resolve) => { signal = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const decision = db.transaction(async (transaction) => {
      await transaction.update(intakeItems).set({ outcome: "rejected" }).where(eq(intakeItems.id, item.id));
      signal(); await gate;
    });
    await locked;
    let settled = false;
    const deletion = env.assets.deleteAsset.handler({ userId: env.guest.id }, { assetId: asset.id }).then(() => null, (error) => error).finally(() => { settled = true; });
    await Bun.sleep(100);
    const settledBeforeDecision = settled;
    release(); await decision;
    expect(settledBeforeDecision).toBe(false);
    expect(await deletion).toMatchObject({ status: 400 });
    const [retained] = await db.select().from(assetTable).where(eq(assetTable.id, asset.id));
    expect(retained).toBeDefined();
    expect(env.mem.objects.has(retained!.storageKey)).toBe(true);
    expect((await db.select().from(activities).where(eq(activities.entityId, item.workItemId))).some((row) => row.field === "attachment_removed")).toBe(false);
  } finally { await db.delete(workspaces).where(eq(workspaces.id, env.workspace.id)); }
});

test.concurrent("the uploader can discard pending bytes after an Intake decision or feature disable", async () => {
  await withRollback(db, async (transaction) => {
    const env = await setup(transaction);
    const intake = createIntakeActions(transaction);
    const file = { filename: "partial.bin", contentType: "application/octet-stream", size: 10 };
    const rejected = await intake.submitIntakeItem.handler({ userId: env.guest.id }, { projectId: env.project.id, title: "Reject" });
    const disabled = await intake.submitIntakeItem.handler({ userId: env.guest.id }, { projectId: env.project.id, title: "Disable" });
    const first = await env.assets.requestAssetUpload.handler({ userId: env.guest.id }, { ownerType: "work_item", ownerId: rejected.workItemId, ...file });
    const second = await env.assets.requestAssetUpload.handler({ userId: env.guest.id }, { ownerType: "work_item", ownerId: disabled.workItemId, ...file });
    env.mem.put(first.fields.key!, 4); env.mem.put(second.fields.key!, 4);
    await intake.rejectIntakeItem.handler({ userId: env.member.id }, { intakeItemId: rejected.id });
    await expect(env.assets.cancelAssetUpload.handler({ userId: env.member.id }, { assetId: first.assetId })).rejects.toMatchObject({ status: 404 });
    await expect(env.assets.completeAssetUpload.handler({ userId: env.guest.id }, { assetId: first.assetId })).rejects.toMatchObject({ status: 400 });
    await env.assets.cancelAssetUpload.handler({ userId: env.guest.id }, { assetId: first.assetId });
    await createProjectActions(transaction).setProjectFeatures.handler({ userId: env.admin.id }, { projectId: env.project.id, features: { intake: false } });
    await expect(env.assets.completeAssetUpload.handler({ userId: env.guest.id }, { assetId: second.assetId })).rejects.toMatchObject({ status: 400 });
    await env.assets.cancelAssetUpload.handler({ userId: env.guest.id }, { assetId: second.assetId });
    expect(env.mem.objects.size).toBe(0);
    expect(await transaction.select().from(assetTable).where(eq(assetTable.id, first.assetId))).toHaveLength(0);
    expect(await transaction.select().from(assetTable).where(eq(assetTable.id, second.assetId))).toHaveLength(0);
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
      if (expected) {
        const attachment = await env.assets.getAssetDownloadUrl.handler({ userId: env.member.id }, { assetId: asset.id, download: true });
        expect(attachment.inline).toBe(false);
        expect(attachment.url).toContain("type=application%2Foctet-stream");
      }
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

test.concurrent("assets on a wiki comment of a project page are not downloadable by project members who cannot read the page", async () => {
  await withRollback(db, async (transaction) => {
    const env = await setup(transaction);
    const wiki = createWikiActions(transaction);
    const page = await wiki.createWikiPage.handler({ userId: env.member.id }, { workspaceId: env.workspace.id, projectId: env.project.id, title: "Private in project", access: "private" });
    const comment = await wiki.createWikiPageComment.handler({ userId: env.member.id }, { pageId: page.id, anchor: "a", body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "note" }] }] } }) as { id: string };
    const asset = await upload(env, env.member.id, { filename: "a.png", contentType: "image/png", size: 10 }, { ownerType: "comment", ownerId: comment.id });
    await expect(env.assets.getAssetDownloadUrl.handler({ userId: env.guest.id }, { assetId: asset.id })).rejects.toMatchObject({ status: 404 });
    await expect(env.assets.deleteAsset.handler({ userId: env.guest.id }, { assetId: asset.id })).rejects.toBeDefined();
    await expect(env.assets.getAssetDownloadUrl.handler({ userId: env.member.id }, { assetId: asset.id })).resolves.toBeDefined();
  });
});
