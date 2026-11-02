import { afterAll, expect, test } from "bun:test";
import { inflateRawSync } from "node:zlib";
import { eq } from "drizzle-orm";
import { createDatabase, comments, exports as exportTable, estimatePoints, estimates, jobs, webLinks, workItemRelations, workItems, type Database } from "@weft/db";
import {
  createActionList, createConfirmationStore, createCycleActions, createExportActions, createIntakeActions, createJobHandlers, createModuleActions, createProjectActions, createWorkItemActions,
  csvCell, enqueueJob, handleExportCleanup, exportColumns, exportJobType, exportLinkTtlMs, runNextJob, type ExportStorage,
} from "../src";
import { createMemberFactory, createWorkspaceFactory, withRollback } from "../../db/src/test-helpers";

const { client, db } = createDatabase();
afterAll(async () => client.end());

const status = (promise: Promise<unknown>) => promise.then(() => 200, (error: { status?: number }) => error.status ?? 500);

function memoryStorage() {
  const files = new Map<string, { body: string; bytes: Uint8Array; contentType: string }>();
  const links: Array<{ key: string; filename: string; expiresInSeconds?: number }> = [];
  const storage: ExportStorage = {
    presignPost: () => { throw new Error("unused"); },
    head: async (key) => files.has(key) ? { size: files.get(key)!.body.length } : null,
    remove: async (key) => { files.delete(key); },
    copy: async () => {},
    presignGet: (input) => { links.push(input); return { url: `https://files.test/${input.key}?expires=${input.expiresInSeconds}` }; },
    put: async (key, body, contentType) => { const bytes = body as Uint8Array; files.set(key, { body: new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes), bytes, contentType }); },
  };
  return { storage, files, links };
}

async function setup(transaction: Database) {
  const workspace = await createWorkspaceFactory(transaction);
  const admin = await createMemberFactory(transaction, workspace.id, "Admin");
  const member = await createMemberFactory(transaction, workspace.id, "Member");
  const other = await createMemberFactory(transaction, workspace.id, "Member");
  const guest = await createMemberFactory(transaction, workspace.id, "Guest");
  const stranger = await createMemberFactory(transaction, (await createWorkspaceFactory(transaction)).id, "Admin");
  const projects = createProjectActions(transaction);
  const project = await projects.createProject.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Mobile", key: "MOB", visibility: "public" });
  await projects.addProjectMember.handler({ userId: admin.id }, { projectId: project.id, userId: member.id, role: "Member" });
  await projects.addProjectMember.handler({ userId: admin.id }, { projectId: project.id, userId: other.id, role: "Member" });
  const secret = await projects.createProject.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Secret", key: "SEC", visibility: "private" });
  const work = createWorkItemActions(transaction);
  const states = await work.listStates.handler({ userId: admin.id }, { projectId: project.id });
  const state = (group: string) => states.find((row) => row.group === group)!;
  const files = memoryStorage();
  const exportActions = createExportActions(transaction, { storage: files.storage });
  const handlers = createJobHandlers(undefined, { exportStorage: files.storage });
  const only = { [exportJobType]: handlers[exportJobType]! };
  const run = () => runNextJob(transaction, only);
  const request = (userId: string, projectIds = [project.id], extra: Record<string, unknown> = {}) => exportActions.requestExport.handler({ userId }, { workspaceId: workspace.id, projectIds, ...extra } as never);
  return { workspace, admin, member, other, guest, stranger, projects, project, secret, work, states, state, files, exportActions, only, run, request, transaction };
}

test.concurrent("only Admin and Member may request, list and fetch; a Guest and a stranger are refused", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    expect(await Promise.all([s.admin.id, s.member.id, s.guest.id, s.stranger.id].map((id) => status(s.request(id))))).toEqual([200, 200, 403, 403]);
    const list = (userId: string) => status(s.exportActions.listExports.handler({ userId }, { workspaceId: s.workspace.id }));
    expect(await Promise.all([s.admin.id, s.member.id, s.guest.id, s.stranger.id].map(list))).toEqual([200, 200, 403, 403]);
    const mine = (await s.exportActions.listExports.handler({ userId: s.member.id }, { workspaceId: s.workspace.id }))[0]!;
    const link = (userId: string) => status(s.exportActions.getExportDownloadUrl.handler({ userId }, { exportId: mine.id }));
    await s.run(); await s.run();
    expect(await Promise.all([s.guest.id, s.stranger.id].map(link))).toEqual([404, 404]);
  });
});

test.concurrent("a request names only projects the caller belongs to; a private project reads as missing, even for an Admin who is not a member", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    // The Admin created Secret, so is a member of both. The Member is in Mobile only.
    expect(await status(s.request(s.member.id, [s.secret.id]))).toBe(404);
    expect(await status(s.request(s.member.id, [s.project.id]))).toBe(200);
    expect(await status(s.request(s.admin.id, [s.secret.id]))).toBe(200);
    expect(await status(s.request(s.member.id, [crypto.randomUUID()]))).toBe(404);
    // An empty choice means every project the caller belongs to, which is only Mobile for the Member.
    const all = await s.request(s.member.id, []);
    expect(all.projectIds).toEqual([s.project.id]);
    const elsewhere = (await transaction.query.workspaceMembers.findFirst({ where: (table, { eq: is }) => is(table.userId, s.stranger.id) }))!.workspaceId;
    const other = await createProjectActions(transaction).createProject.handler({ userId: s.stranger.id }, { workspaceId: elsewhere, name: "Elsewhere", key: "ELS", visibility: "public" });
    expect(await status(s.request(s.admin.id, [other.id]))).toBe(404);
  });
});

test.concurrent("a request makes a queued Export owned by the caller and one job; users list only their own", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    const created = await s.request(s.member.id);
    expect(created).toMatchObject({ workspaceId: s.workspace.id, projectIds: [s.project.id], projects: [{ id: s.project.id, key: "MOB", name: "Mobile" }], format: "csv", status: "queued", failureReason: null, completedAt: null });
    const [row] = await transaction.select().from(exportTable).where(eq(exportTable.id, created.id));
    expect(row).toMatchObject({ ownerId: s.member.id, fileKey: null });
    const [job] = await transaction.select().from(jobs).where(eq(jobs.type, exportJobType));
    expect(job!.payload).toEqual({ exportId: created.id });
    await s.request(s.other.id, [s.project.id], { format: "csv" });
    expect((await s.exportActions.listExports.handler({ userId: s.member.id }, { workspaceId: s.workspace.id })).map((item) => item.id)).toEqual([created.id]);
    // Someone else's Export is missing for its link too, an Admin's included.
    expect(await status(s.exportActions.getExportDownloadUrl.handler({ userId: s.admin.id }, { exportId: created.id }))).toBe(404);
  });
});

test.concurrent("a repeated request with the same choice while one is open is skipped by the dedupe key", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    const first = await s.request(s.member.id);
    const second = await s.request(s.member.id);
    expect(second.id).toBe(first.id);
    expect(await transaction.select().from(exportTable).where(eq(exportTable.ownerId, s.member.id))).toHaveLength(1);
    expect(await transaction.select().from(jobs).where(eq(jobs.type, exportJobType))).toHaveLength(1);
    // Another person's identical choice is its own Export.
    expect((await s.request(s.other.id)).id).not.toBe(first.id);
    // Once the first is done, the same choice starts a new Export.
    await s.run(); await s.run();
    expect((await s.request(s.member.id)).id).not.toBe(first.id);
  });
});

test.concurrent("the worker writes the CSV for a known dataset: columns, archived in, Triage out, escaping and the formula guard", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    const as = { userId: s.member.id };
    const label = await s.work.createLabel.handler({ userId: s.admin.id }, { projectId: s.project.id, name: "bug", color: "#ff0000" });
    const label2 = await s.work.createLabel.handler({ userId: s.admin.id }, { projectId: s.project.id, name: "ui, polish", color: "#00ff00" });
    const cycle = await createCycleActions(transaction).createCycle.handler(as, { projectId: s.project.id, name: "Sprint 1", startDate: "2099-01-01", endDate: "2099-01-14" });
    const modules = createModuleActions(transaction);
    const alpha = await modules.createModule.handler(as, { projectId: s.project.id, name: "Alpha" });
    const beta = await modules.createModule.handler(as, { projectId: s.project.id, name: "Beta" });

    const parent = await s.work.createWorkItem.handler(as, { projectId: s.project.id, title: "Parent", priority: "high" });
    const child = await s.work.createWorkItem.handler(as, {
      projectId: s.project.id, title: 'Say "hi", then\nbreak', parentId: parent.id, assigneeIds: [s.member.id, s.other.id], labelIds: [label2.id, label.id],
      startDate: "2026-02-01", dueDate: "2026-02-28", stateId: s.state("started").id,
    } as never);
    const formula = await s.work.createWorkItem.handler(as, { projectId: s.project.id, title: '=HYPERLINK("http://evil","x")' });
    const plus = await s.work.createWorkItem.handler(as, { projectId: s.project.id, title: "+1 and @me\tx" });
    const archived = await s.work.createWorkItem.handler(as, { projectId: s.project.id, title: "Old", stateId: s.state("completed").id });
    await createCycleActions(transaction).addCycleItems.handler(as, { cycleId: cycle.id, workItemIds: [child.id] });
    await modules.addModuleItems.handler(as, { moduleId: beta.id, workItemIds: [child.id] });
    await modules.addModuleItems.handler(as, { moduleId: alpha.id, workItemIds: [child.id] });
    const triage = await createIntakeActions(transaction).submitIntakeItem.handler(as, { projectId: s.project.id, title: "Undecided" });
    expect(triage.title).toBe("Undecided");
    // Other project's item must not appear.
    await s.work.createWorkItem.handler({ userId: s.admin.id }, { projectId: s.secret.id, title: "Secret item" });

    const stamp = (n: number) => new Date(Date.UTC(2026, 2, n, 10, 30, 0));
    for (const [item, n] of [[parent, 1], [child, 2], [formula, 3], [plus, 4], [archived, 5]] as const) {
      await transaction.update(workItems).set({ createdAt: stamp(n), updatedAt: stamp(n + 10) }).where(eq(workItems.id, item.id));
    }
    await transaction.update(workItems).set({ completedAt: stamp(6), archivedAt: stamp(7) }).where(eq(workItems.id, archived.id));

    const created = await s.request(s.member.id);
    expect(await s.run()).toMatchObject({ status: "succeeded", type: exportJobType });
    const [row] = await transaction.select().from(exportTable).where(eq(exportTable.id, created.id));
    expect(row).toMatchObject({ status: "completed", failureReason: null, fileKey: `${s.workspace.id}/exports/${created.id}.csv` });
    expect(row!.completedAt).not.toBeNull();
    const file = s.files.files.get(row!.fileKey!)!;
    expect(file.contentType).toBe("text/csv; charset=utf-8");
    expect(row!.fileSize).toBe(new TextEncoder().encode(file.body).byteLength);

    const header = exportColumns.join(",");
    expect(header).toBe("project,key,title,state,state_group,priority,assignees,labels,cycle,modules,parent_key,start_date,due_date,created_at,updated_at,completed_at,archived_at,sub_work_item_count,web_links,relations,comments");
    const names = [s.member.name, s.other.name].sort().join("; ");
    const [backlog, started, completed] = [s.state("backlog").name, s.state("started").name, s.state("completed").name];
    const lines = [
      header,
      `Mobile,MOB-1,Parent,${backlog},backlog,high,,,,,,,,2026-03-01T10:30:00.000Z,2026-03-11T10:30:00.000Z,,`,
      `Mobile,MOB-2,"Say ""hi"", then\nbreak",${started},started,none,${names},"bug; ui, polish",Sprint 1,Alpha; Beta,MOB-1,2026-02-01,2026-02-28,2026-03-02T10:30:00.000Z,2026-03-12T10:30:00.000Z,,`,
      `Mobile,MOB-3,"'=HYPERLINK(""http://evil"",""x"")",${backlog},backlog,none,,,,,,,,2026-03-03T10:30:00.000Z,2026-03-13T10:30:00.000Z,,`,
      `Mobile,MOB-4,'+1 and @me\tx,${backlog},backlog,none,,,,,,,,2026-03-04T10:30:00.000Z,2026-03-14T10:30:00.000Z,,`,
      `Mobile,MOB-5,Old,${completed},completed,none,,,,,,,,2026-03-05T10:30:00.000Z,2026-03-15T10:30:00.000Z,2026-03-06T10:30:00.000Z,2026-03-07T10:30:00.000Z`,
    ];
    expect(file.body).toBe(`﻿${[lines[0], ...lines.slice(1).map((line, index) => `${line},${index === 0 ? 1 : 0},,,`)].join("\r\n")}\r\n`);
    // Check the list shows it completed with the size.
    const listed = (await s.exportActions.listExports.handler({ userId: s.member.id }, { workspaceId: s.workspace.id }))[0]!;
    expect(listed).toMatchObject({ status: "completed", size: row!.fileSize });
  });
});

test("csvCell escapes commas, quotes and line breaks and guards leading formula characters", () => {
  expect(csvCell("plain")).toBe("plain");
  expect(csvCell("a,b")).toBe('"a,b"');
  expect(csvCell('say "x"')).toBe('"say ""x"""');
  expect(csvCell("one\ntwo")).toBe('"one\ntwo"');
  expect(csvCell("one\r\ntwo")).toBe('"one\r\ntwo"');
  for (const lead of ["=", "+", "-", "@", "\t", "\r"]) expect(csvCell(`${lead}1+1`).replace(/^"|"$/g, "").startsWith("'")).toBe(true);
  expect(csvCell("=1+1")).toBe("'=1+1");
  expect(csvCell("mid=dle")).toBe("mid=dle");
  expect(csvCell(null)).toBe("");
});

test.concurrent("the download link is for a completed Export only, lasts 7 days from completion, then is refused", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    await s.work.createWorkItem.handler({ userId: s.member.id }, { projectId: s.project.id, title: "One" });
    const created = await s.request(s.member.id);
    const link = (at?: Date) => createExportActions(transaction, { storage: s.files.storage, now: at ? () => at : undefined }).getExportDownloadUrl.handler({ userId: s.member.id }, { exportId: created.id });
    expect(await link().catch((error: { status?: number }) => error.status)).toBe(409);
    await s.run();
    const [row] = await transaction.select().from(exportTable).where(eq(exportTable.id, created.id));
    const done = row!.completedAt!;
    const fresh = await link(done);
    expect(fresh.url).toBe(`https://files.test/${row!.fileKey}?expires=${exportLinkTtlMs / 1000}`);
    expect(fresh.filename).toBe(`MOB-work-items-${done.toISOString().slice(0, 10)}.csv`);
    expect(fresh.expiresAt).toBe(new Date(done.getTime() + exportLinkTtlMs).toISOString());
    expect(s.files.links.at(-1)).toMatchObject({ key: row!.fileKey, inline: false });
    const later = await link(new Date(done.getTime() + exportLinkTtlMs - 60_000));
    expect(later.url).toContain("expires=60");
    expect(await link(new Date(done.getTime() + exportLinkTtlMs)).catch((error: { status?: number }) => error.status)).toBe(410);
  });
});

test.concurrent("a file over the Export size bound fails the Export at once with a readable reason and no file", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    await s.work.createWorkItem.handler({ userId: s.member.id }, { projectId: s.project.id, title: "Big enough" });
    const created = await s.request(s.member.id);
    const handlers = createJobHandlers(undefined, { exportStorage: s.files.storage, maxExportBytes: () => 120 });
    expect(await runNextJob(transaction, { [exportJobType]: handlers[exportJobType]! })).toMatchObject({ status: "succeeded" });
    const [row] = await transaction.select().from(exportTable).where(eq(exportTable.id, created.id));
    expect(row).toMatchObject({ status: "failed", fileKey: null });
    expect(row!.failureReason).toContain("limit");
    expect(s.files.files.size).toBe(0);
    expect(await status(s.exportActions.getExportDownloadUrl.handler({ userId: s.member.id }, { exportId: created.id }))).toBe(409);
  });
});

test.concurrent("a storage error is retried, and the last attempt leaves the Export failed with a reason", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    const broken: ExportStorage = { ...s.files.storage, put: async () => { throw new Error("storage down"); } };
    const handlers = { [exportJobType]: createJobHandlers(undefined, { exportStorage: broken })[exportJobType]! };
    const created = await s.request(s.member.id);
    const [job] = await transaction.select().from(jobs).where(eq(jobs.type, exportJobType));
    await transaction.update(jobs).set({ maxAttempts: 2 }).where(eq(jobs.id, job!.id));
    const t0 = new Date();
    expect(await runNextJob(transaction, handlers, { now: () => t0, retryDelayMs: 1000 })).toMatchObject({ status: "retrying" });
    expect((await transaction.select().from(exportTable).where(eq(exportTable.id, created.id)))[0]).toMatchObject({ status: "queued", failureReason: null });
    expect(await runNextJob(transaction, handlers, { now: () => new Date(t0.getTime() + 60_000), retryDelayMs: 1000 })).toMatchObject({ status: "failed" });
    const [row] = await transaction.select().from(exportTable).where(eq(exportTable.id, created.id));
    expect(row!.status).toBe("failed");
    expect(row!.failureReason).toBe("The file could not be built. Try again.");
    // The reason does not leak the storage error.
    expect(row!.failureReason).not.toContain("storage down");
  });
});

test.concurrent("losing the project before the job runs fails the Export without a file", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    const created = await s.request(s.member.id);
    await createProjectActions(transaction).removeProjectMember.handler({ userId: s.admin.id }, { projectId: s.project.id, userId: s.member.id });
    await s.run();
    const [row] = await transaction.select().from(exportTable).where(eq(exportTable.id, created.id));
    expect(row).toMatchObject({ status: "failed", fileKey: null, failureReason: "You no longer have access to the chosen project" });
    expect(s.files.files.size).toBe(0);
  });
});

test.concurrent("the Actions are in the registry and request_export is a Write action the AI may propose only as a Confirmation card", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    const list = createActionList(transaction);
    expect(list.filter((action) => ["request_export", "list_exports", "get_export_download_url"].includes(action.name)).map((action) => [action.name, action.kind]).sort())
      .toEqual([["get_export_download_url", "read"], ["list_exports", "read"], ["request_export", "write"]]);
    const store = createConfirmationStore(transaction);
    const card = await store.propose({ userId: s.member.id, workspaceId: s.workspace.id, action: "request_export", input: { projectIds: [s.project.id] } });
    expect(card).toMatchObject({ action: "request_export", status: "pending", input: { workspaceId: s.workspace.id, projectIds: [s.project.id] } });
    // Proposing starts nothing.
    expect(await transaction.select().from(exportTable)).toHaveLength(0);
    expect(await status(store.propose({ userId: s.guest.id, workspaceId: s.workspace.id, action: "request_export", input: { projectIds: [s.project.id] } }))).toBe(403);
  });
});

test.concurrent("the page data says expired at the 7-day boundary and the link is refused, before the cleanup job ran", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    await s.work.createWorkItem.handler({ userId: s.member.id }, { projectId: s.project.id, title: "One" });
    const created = await s.request(s.member.id);
    await s.run();
    const [row] = await transaction.select().from(exportTable).where(eq(exportTable.id, created.id));
    const done = row!.completedAt!;
    const at = (ms: number) => createExportActions(transaction, { storage: s.files.storage, now: () => new Date(done.getTime() + ms) });
    const list = async (ms: number) => (await at(ms).listExports.handler({ userId: s.member.id }, { workspaceId: s.workspace.id }))[0]!;
    expect(await list(exportLinkTtlMs - 1)).toMatchObject({ expired: false, status: "completed" });
    expect(await list(exportLinkTtlMs)).toMatchObject({ expired: true, status: "completed" });
    const link = (ms: number) => at(ms).getExportDownloadUrl.handler({ userId: s.member.id }, { exportId: created.id });
    expect((await link(exportLinkTtlMs - 1)).url).toContain("expires=1");
    expect(await link(exportLinkTtlMs).catch((error: { status?: number; message: string }) => `${error.status} ${error.message}`)).toBe("410 The Export has expired");
  });
});

test.concurrent("cleanup_exports deletes the file of Exports past 7 days, keeps the row, leaves newer ones, and is safe to run twice", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    await s.work.createWorkItem.handler({ userId: s.member.id }, { projectId: s.project.id, title: "One" });
    const old = await s.request(s.member.id);
    await s.run();
    const [oldRow] = await transaction.select().from(exportTable).where(eq(exportTable.id, old.id));
    // A second, fresher Export of the same member (the first is no longer open, so no dedupe).
    const fresh = await s.request(s.member.id);
    await s.run();
    const [freshRow] = await transaction.select().from(exportTable).where(eq(exportTable.id, fresh.id));
    // Make the first one 7 days old exactly and keep the second one a minute younger than that.
    await transaction.update(exportTable).set({ completedAt: new Date(Date.now() - exportLinkTtlMs) }).where(eq(exportTable.id, old.id));
    await transaction.update(exportTable).set({ completedAt: new Date(Date.now() - exportLinkTtlMs + 60_000) }).where(eq(exportTable.id, fresh.id));
    expect(s.files.files.has(oldRow!.fileKey!)).toBe(true);
    const run = () => handleExportCleanup(transaction, { storage: s.files.storage });
    await run(); await run();
    expect(s.files.files.has(oldRow!.fileKey!)).toBe(false);
    expect(s.files.files.has(freshRow!.fileKey!)).toBe(true);
    const rows = await transaction.select().from(exportTable).where(eq(exportTable.workspaceId, s.workspace.id));
    expect(rows).toHaveLength(2);
    const after = new Map(rows.map((row) => [row.id, row]));
    expect(after.get(old.id)).toMatchObject({ status: "completed", fileKey: null });
    expect(after.get(old.id)!.expiredAt).not.toBeNull();
    expect(after.get(fresh.id)!.expiredAt).toBeNull();
    const list = await s.exportActions.listExports.handler({ userId: s.member.id }, { workspaceId: s.workspace.id });
    expect(list.map((item) => [item.id, item.expired]).sort()).toEqual([[old.id, true], [fresh.id, false]].sort());
    expect(await status(s.exportActions.getExportDownloadUrl.handler({ userId: s.member.id }, { exportId: old.id }))).toBe(410);
  });
});

test.concurrent("cleanup_exports is wired like the other cleanup jobs and keeps going past a failing delete", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    await s.work.createWorkItem.handler({ userId: s.member.id }, { projectId: s.project.id, title: "One" });
    const first = await s.request(s.member.id);
    await s.run();
    const second = await s.request(s.admin.id);
    await s.run();
    const old = new Date(Date.now() - exportLinkTtlMs - 1000);
    await transaction.update(exportTable).set({ completedAt: old }).where(eq(exportTable.workspaceId, s.workspace.id));
    const [firstRow] = await transaction.select().from(exportTable).where(eq(exportTable.id, first.id));
    const broken: ExportStorage = { ...s.files.storage, remove: async (key) => { if (key === firstRow!.fileKey) throw new Error("storage down"); await s.files.storage.remove(key); } };
    const handlers = createJobHandlers(undefined, { exportStorage: broken });
    await expect(handlers.cleanup_exports!(transaction, {}, { id: "j", type: "cleanup_exports" })).rejects.toThrow("storage down");
    const rows = new Map((await transaction.select().from(exportTable).where(eq(exportTable.workspaceId, s.workspace.id))).map((row) => [row.id, row]));
    expect(rows.get(first.id)!.expiredAt).toBeNull();
    expect(rows.get(second.id)!.expiredAt).not.toBeNull();
    // Once storage works again the retry finishes the rest.
    await createJobHandlers(undefined, { exportStorage: s.files.storage }).cleanup_exports!(transaction, {}, { id: "j", type: "cleanup_exports" });
    expect((await transaction.select().from(exportTable).where(eq(exportTable.id, first.id)))[0]!.expiredAt).not.toBeNull();
  });
});

/** Reads a ZIP through its central directory, as an unzip tool does. */
function readZip(bytes: Uint8Array) {
  const view = Buffer.from(bytes);
  const end = view.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = view.readUInt16LE(end + 10);
  let at = view.readUInt32LE(end + 16);
  const entries: Record<string, string> = {};
  for (let i = 0; i < count; i++) {
    expect(view.readUInt32LE(at)).toBe(0x02014b50);
    const [method, packedSize, nameLength, extraLength, commentLength, local] = [view.readUInt16LE(at + 10), view.readUInt32LE(at + 20), view.readUInt16LE(at + 28), view.readUInt16LE(at + 30), view.readUInt16LE(at + 32), view.readUInt32LE(at + 42)];
    const name = view.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    const data = local + 30 + view.readUInt16LE(local + 26) + view.readUInt16LE(local + 28);
    expect(method).toBe(8);
    entries[name] = inflateRawSync(view.subarray(data, data + packedSize)).toString("utf8");
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

test.concurrent("JSON nests assignees, labels and modules as arrays and keeps one file for one project", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    const as = { userId: s.member.id };
    const label = await s.work.createLabel.handler({ userId: s.admin.id }, { projectId: s.project.id, name: "ui, polish", color: "#00ff00" });
    const cycle = await createCycleActions(transaction).createCycle.handler(as, { projectId: s.project.id, name: "Sprint 1", startDate: "2099-01-01", endDate: "2099-01-14" });
    const modules = createModuleActions(transaction);
    const alpha = await modules.createModule.handler(as, { projectId: s.project.id, name: "Alpha" });
    const parent = await s.work.createWorkItem.handler(as, { projectId: s.project.id, title: "Parent" });
    const child = await s.work.createWorkItem.handler(as, { projectId: s.project.id, title: "=Child \"x\"", parentId: parent.id, assigneeIds: [s.member.id], labelIds: [label.id], dueDate: "2026-02-28" } as never);
    await createCycleActions(transaction).addCycleItems.handler(as, { cycleId: cycle.id, workItemIds: [child.id] });
    await modules.addModuleItems.handler(as, { moduleId: alpha.id, workItemIds: [child.id] });
    await createIntakeActions(transaction).submitIntakeItem.handler(as, { projectId: s.project.id, title: "Undecided" });
    await transaction.update(workItems).set({ archivedAt: new Date(Date.UTC(2026, 2, 7, 10, 30)) }).where(eq(workItems.id, parent.id));

    const created = await s.request(s.member.id, [s.project.id], { format: "json" });
    expect(created.format).toBe("json");
    await s.run();
    const [row] = await transaction.select().from(exportTable).where(eq(exportTable.id, created.id));
    expect(row).toMatchObject({ status: "completed", fileKey: `${s.workspace.id}/exports/${created.id}.json` });
    const file = s.files.files.get(row!.fileKey!)!;
    expect(file.contentType).toBe("application/json; charset=utf-8");
    expect(row!.fileSize).toBe(file.bytes.byteLength);
    const items = JSON.parse(file.body) as Array<Record<string, unknown>>;
    expect(items.map((item) => item.key)).toEqual(["MOB-1", "MOB-2"]);
    expect(items[0]).toMatchObject({ project: "Mobile", title: "Parent", assignees: [], labels: [], cycle: null, modules: [], parent_key: null, start_date: null, completed_at: null, archived_at: "2026-03-07T10:30:00.000Z" });
    // Values are the data as it is: no formula guard in JSON.
    expect(items[1]).toMatchObject({
      title: '=Child "x"', priority: "none", assignees: [s.member.name], labels: ["ui, polish"], cycle: "Sprint 1", modules: ["Alpha"], parent_key: "MOB-1",
      start_date: null, due_date: "2026-02-28", archived_at: null,
    });
    expect(Object.keys(items[1]!)).toEqual([...exportColumns]);
    const listed = (await s.exportActions.listExports.handler({ userId: s.member.id }, { workspaceId: s.workspace.id }))[0]!;
    expect(listed.format).toBe("json");
    const link = await s.exportActions.getExportDownloadUrl.handler({ userId: s.member.id }, { exportId: created.id });
    expect(link.filename).toMatch(/^MOB-work-items-\d{4}-\d{2}-\d{2}\.json$/);
    // The same project as CSV is another choice, so it is not a duplicate.
    expect((await s.request(s.member.id, [s.project.id], { format: "csv" })).id).not.toBe(created.id);
  });
});

test.concurrent("CSV and JSON exports include sub-item counts, Web Links, Relations, Comments, and active Estimate points", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    const as = { userId: s.member.id };
    const parent = await s.work.createWorkItem.handler(as, { projectId: s.project.id, title: "Parent" });
    const child = await s.work.createWorkItem.handler(as, { projectId: s.project.id, title: "Child", parentId: parent.id });
    const third = await s.work.createWorkItem.handler(as, { projectId: s.project.id, title: "Related" });
    const estimate = await transaction.insert(estimates).values({ workspaceId: s.workspace.id, projectId: s.project.id, name: "Estimate", type: "points", createdBy: s.admin.id }).returning();
    const [point] = await transaction.insert(estimatePoints).values([{ estimateId: estimate[0]!.id, position: 0, value: "1" }, { estimateId: estimate[0]!.id, position: 1, value: "3" }]).returning();
    await transaction.update(workItems).set({ estimatePointId: point!.id }).where(eq(workItems.id, child.id));
    await transaction.insert(webLinks).values({ workspaceId: s.workspace.id, projectId: s.project.id, workItemId: child.id, url: "https://example.com", title: "Docs", createdBy: s.member.id });
    await transaction.insert(workItemRelations).values({ workspaceId: s.workspace.id, projectId: s.project.id, workItemId: third.id, relatedWorkItemId: child.id, type: "blocked_by", createdBy: s.member.id });
    await transaction.insert(comments).values({ workspaceId: s.workspace.id, projectId: s.project.id, workItemId: child.id, authorId: s.member.id, body: {}, bodyText: "Needs review", createdAt: new Date("2026-01-02T03:04:05.000Z") });

    const created = await s.request(s.member.id, [s.project.id], { format: "json" });
    await s.run();
    const [row] = await transaction.select().from(exportTable).where(eq(exportTable.id, created.id));
    const items = JSON.parse(s.files.files.get(row!.fileKey!)!.body) as Array<Record<string, unknown>>;
    expect(items[0]).toMatchObject({ key: "MOB-1", sub_work_item_count: 1, estimate_point: null, web_links: [], relations: [], comments: [] });
    expect(items[1]).toMatchObject({ key: "MOB-2", sub_work_item_count: 0, estimate_point: "1", web_links: [{ title: "Docs", url: "https://example.com" }], relations: [{ type: "blocks", key: "MOB-3" }], comments: [{ author: s.member.name, time: "2026-01-02T03:04:05.000Z", text: "Needs review" }] });

    const csvCreated = await s.request(s.member.id, [s.project.id], { format: "csv" });
    await s.run();
    const [csvExport] = await transaction.select().from(exportTable).where(eq(exportTable.id, csvCreated.id));
    const csv = s.files.files.get(csvExport!.fileKey!)!.body;
    expect(csv.split("\r\n")[0]).toContain("parent_key,estimate_point,start_date,due_date,created_at,updated_at,completed_at,archived_at,sub_work_item_count,web_links,relations,comments");
    expect(csv).toContain("https://example.com");
    expect(csv).toContain("blocks: MOB-3");
    expect(csv).toContain(`${s.member.name}: 2026-01-02T03:04:05.000Z: Needs review`);
  });
});

test.concurrent("an empty project choice exports every project the caller belongs to, and the choice is stored as that list", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    // The Admin created Mobile and Secret; the Member belongs to Mobile only; a project elsewhere is never included.
    const all = await s.request(s.admin.id, [], { format: "json" });
    expect([...all.projectIds].sort()).toEqual([s.project.id, s.secret.id].sort());
    expect(all.projects.map((project) => project.key).sort()).toEqual(["MOB", "SEC"]);
    expect((await s.request(s.member.id, undefined as never)).projectIds).toEqual([s.project.id]);
    // The same choice again while one is open is the dedupe key's duplicate; naming the projects explicitly is the same choice.
    expect((await s.request(s.admin.id, [s.secret.id, s.project.id], { format: "json" })).id).toBe(all.id);
    // A Member of no project has nothing to export.
    const lonely = await createMemberFactory(transaction, s.workspace.id, "Member");
    expect(await status(s.request(lonely.id, []))).toBe(400);
    expect(await status(s.request(s.guest.id, []))).toBe(403);
  });
});

test.concurrent("a project the caller does not belong to is refused even beside ones they do, and nothing is queued", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    expect(await status(s.request(s.member.id, [s.project.id, s.secret.id], { format: "json" }))).toBe(404);
    expect(await transaction.select().from(exportTable)).toHaveLength(0);
    expect(await transaction.select().from(jobs).where(eq(jobs.type, exportJobType))).toHaveLength(0);
  });
});

test.concurrent("several projects give a ZIP with one file per project named by project key, in the chosen format", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    await s.work.createWorkItem.handler({ userId: s.admin.id }, { projectId: s.project.id, title: "Mobile one" });
    await s.work.createWorkItem.handler({ userId: s.admin.id }, { projectId: s.project.id, title: "Mobile two" });
    await s.work.createWorkItem.handler({ userId: s.admin.id }, { projectId: s.secret.id, title: "Secret one, with comma" });
    for (const format of ["csv", "json"] as const) {
      const created = await s.request(s.admin.id, [s.secret.id, s.project.id], { format });
      await s.run();
      const [row] = await transaction.select().from(exportTable).where(eq(exportTable.id, created.id));
      expect(row).toMatchObject({ status: "completed", fileKey: `${s.workspace.id}/exports/${created.id}.zip` });
      const file = s.files.files.get(row!.fileKey!)!;
      expect(file.contentType).toBe("application/zip");
      expect(row!.fileSize).toBe(file.bytes.byteLength);
      const entries = readZip(file.bytes);
      expect(Object.keys(entries).sort()).toEqual([`MOB.${format}`, `SEC.${format}`]);
      if (format === "csv") {
        expect(entries["MOB.csv"]!.replace(/^\uFEFF/, "").split("\r\n").filter(Boolean).map((line) => line.split(",")[1])).toEqual(["key", "MOB-1", "MOB-2"]);
        expect(entries["SEC.csv"]).toContain('Secret,SEC-1,"Secret one, with comma"');
      } else {
        expect((JSON.parse(entries["MOB.json"]!) as Array<{ key: string }>).map((item) => item.key)).toEqual(["MOB-1", "MOB-2"]);
        expect(JSON.parse(entries["SEC.json"]!)).toMatchObject([{ key: "SEC-1", project: "Secret", title: "Secret one, with comma" }]);
      }
      const link = await s.exportActions.getExportDownloadUrl.handler({ userId: s.admin.id }, { exportId: created.id });
      expect(link.filename).toMatch(/^work-items-\d{4}-\d{2}-\d{2}\.zip$/);
    }
  });
});

test.concurrent("an empty project has an empty JSON array, and the size bound counts all files of a ZIP", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    const empty = await s.request(s.admin.id, [s.project.id], { format: "json" });
    await s.run();
    expect(s.files.files.get(`${s.workspace.id}/exports/${empty.id}.json`)!.body).toBe("[]\n");
    await s.work.createWorkItem.handler({ userId: s.admin.id }, { projectId: s.project.id, title: "One" });
    await s.work.createWorkItem.handler({ userId: s.admin.id }, { projectId: s.secret.id, title: "Two" });
    const one = await s.request(s.admin.id, [s.project.id], { format: "csv" });
    await s.run();
    const single = s.files.files.get(`${s.workspace.id}/exports/${one.id}.csv`)!.bytes.byteLength;
    // Each project's file fits alone, but together they pass the bound.
    const created = await s.request(s.admin.id, [s.project.id, s.secret.id], { format: "csv" });
    const handlers = createJobHandlers(undefined, { exportStorage: s.files.storage, maxExportBytes: () => single + 20 });
    await runNextJob(transaction, { [exportJobType]: handlers[exportJobType]! });
    const [row] = await transaction.select().from(exportTable).where(eq(exportTable.id, created.id));
    expect(row).toMatchObject({ status: "failed", fileKey: null });
    expect(row!.failureReason).toContain("limit");
  });
});
