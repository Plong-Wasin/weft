import { Type } from "@sinclair/typebox";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Database } from "@weft/db";
import { cycleItems, cycles, exports as exportTable, jobs, moduleItems, modules, projectMembers, projects, users, workItemAssignees, workItemLabels, workItemStates, workItems, labels } from "@weft/db";
import { enqueueJob } from "./jobs";
import { ActionError, requireWorkspaceRole } from "./members";
import { createS3Storage, type ExportStorage } from "./storage";
import { notInTriage } from "./triage";
import { createZip } from "./zip";

const uuid = () => Type.String({ format: "uuid" });
const nullable = <T extends import("@sinclair/typebox").TSchema>(schema: T) => Type.Union([schema, Type.Null()]);

export const exportJobType = "export_build";
/** The download link stays valid for 7 days from the moment the Export completed. */
export const exportLinkTtlMs = 7 * 24 * 60 * 60 * 1000;
export const defaultMaxExportBytes = 256 * 1024 * 1024;

/** The Export's own size bound: a file over it fails the Export. It is not the Asset limit. */
export function maxExportBytes(env: Record<string, string | undefined> = Bun.env) {
  const parsed = Number(env.EXPORT_MAX_BYTES);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : defaultMaxExportBytes;
}

/** Separator inside a CSV cell that holds several values (assignees, labels, Modules). */
export const csvListSeparator = "; ";
export const exportColumns = [
  "project", "key", "title", "state", "state_group", "priority", "assignees", "labels", "cycle", "modules", "parent_key",
  "start_date", "due_date", "created_at", "updated_at", "completed_at", "archived_at",
] as const;

/** A value a spreadsheet would run as a formula (leading `=`, `+`, `-`, `@`, tab or carriage return) gets a leading apostrophe. */
export function guardFormula(value: string) {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

/** One CSV cell: formula-guarded, and quoted when it holds a comma, quote or line break. */
export function csvCell(value: string | null | undefined) {
  if (value === null || value === undefined || value === "") return "";
  const safe = guardFormula(value);
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

export const csvRow = (values: Array<string | null | undefined>) => `${values.map(csvCell).join(",")}\r\n`;

/** A failure the user can act on (or must accept): the Export fails at once with this reason instead of being retried. */
class ExportFailure extends Error {}

const iso = (value: Date | null) => value ? value.toISOString() : "";

/** One work item as the file holds it; the CSV joins the lists, the JSON keeps them as arrays. */
interface ExportItem {
  project: string; key: string; title: string; state: string; state_group: string; priority: string;
  assignees: string[]; labels: string[]; cycle: string | null; modules: string[]; parent_key: string | null;
  start_date: string | null; due_date: string | null; created_at: string; updated_at: string; completed_at: string | null; archived_at: string | null;
}

/** The work items of one project: live ones including archived, never those in Triage. */
async function collectProjectItems(db: Database, project: { id: string; key: string; name: string }): Promise<ExportItem[]> {
  const parent = alias(workItems, "parent");
  const parentProject = alias(projects, "parent_project");
  const items = await db.select({
    id: workItems.id, sequence: workItems.sequence, title: workItems.title, state: workItemStates.name, stateGroup: workItemStates.group,
    priority: workItems.priority, startDate: workItems.startDate, dueDate: workItems.dueDate, createdAt: workItems.createdAt, updatedAt: workItems.updatedAt,
    completedAt: workItems.completedAt, archivedAt: workItems.archivedAt, parentSequence: parent.sequence, parentKey: parentProject.key,
  }).from(workItems)
    .innerJoin(workItemStates, eq(workItemStates.id, workItems.stateId))
    .leftJoin(parent, and(eq(parent.id, workItems.parentId), isNull(parent.deletedAt)))
    .leftJoin(parentProject, eq(parentProject.id, parent.projectId))
    .where(and(eq(workItems.projectId, project.id), isNull(workItems.deletedAt), notInTriage))
    .orderBy(asc(workItems.sequence));

  const grouped = <T extends { workItemId: string; value: string }>(rows: T[]) => {
    const map = new Map<string, string[]>();
    for (const row of rows) map.set(row.workItemId, [...(map.get(row.workItemId) ?? []), row.value]);
    return map;
  };
  const assignees = grouped(await db.select({ workItemId: workItemAssignees.workItemId, value: users.name }).from(workItemAssignees)
    .innerJoin(workItems, eq(workItems.id, workItemAssignees.workItemId)).innerJoin(users, eq(users.id, workItemAssignees.userId))
    .where(eq(workItems.projectId, project.id)).orderBy(asc(users.name), asc(users.id)));
  const labelNames = grouped(await db.select({ workItemId: workItemLabels.workItemId, value: labels.name }).from(workItemLabels)
    .innerJoin(workItems, eq(workItems.id, workItemLabels.workItemId)).innerJoin(labels, eq(labels.id, workItemLabels.labelId))
    .where(eq(workItems.projectId, project.id)).orderBy(asc(labels.name), asc(labels.id)));
  const cycleNames = grouped(await db.select({ workItemId: cycleItems.workItemId, value: cycles.name }).from(cycleItems)
    .innerJoin(cycles, and(eq(cycles.id, cycleItems.cycleId), isNull(cycles.deletedAt))).where(eq(cycleItems.projectId, project.id)));
  const moduleNames = grouped(await db.select({ workItemId: moduleItems.workItemId, value: modules.name }).from(moduleItems)
    .innerJoin(modules, and(eq(modules.id, moduleItems.moduleId), isNull(modules.deletedAt))).where(eq(moduleItems.projectId, project.id))
    .orderBy(asc(modules.name), asc(modules.id)));

  return items.map((item) => ({
    project: project.name, key: `${project.key}-${item.sequence}`, title: item.title, state: item.state, state_group: item.stateGroup, priority: item.priority,
    assignees: assignees.get(item.id) ?? [], labels: labelNames.get(item.id) ?? [], cycle: cycleNames.get(item.id)?.[0] ?? null, modules: moduleNames.get(item.id) ?? [],
    parent_key: item.parentSequence !== null ? `${item.parentKey}-${item.parentSequence}` : null,
    start_date: item.startDate, due_date: item.dueDate, created_at: iso(item.createdAt), updated_at: iso(item.updatedAt),
    completed_at: item.completedAt ? iso(item.completedAt) : null, archived_at: item.archivedAt ? iso(item.archivedAt) : null,
  }));
}

/** Renders the items as a file, counting bytes against the shared budget of the whole Export. */
function renderItems(items: ExportItem[], format: "csv" | "json", budget: { left: number; limit: number }) {
  const take = (text: string) => {
    budget.left -= Buffer.byteLength(text);
    if (budget.left < 0) throw new ExportFailure(`The file is larger than the Export limit of ${budget.limit} bytes`);
    return text;
  };
  if (format === "json") {
    // One array of objects; assignees, labels and modules stay arrays.
    const rows = items.map((item) => take(JSON.stringify(item, null, 2).replace(/^/gm, "  ")));
    // The rows are counted already; count the brackets and separators too.
    take(rows.length ? `[\n${",\n".repeat(rows.length - 1)}\n]\n` : "[]\n");
    return rows.length ? `[\n${rows.join(",\n")}\n]\n` : "[]\n";
  }
  // The byte-order mark lets spreadsheets read the file as UTF-8 (Thai text opens correctly in Excel).
  let text = take(`\uFEFF${csvRow([...exportColumns])}`);
  for (const item of items) {
    text += take(csvRow([
      item.project, item.key, item.title, item.state, item.state_group, item.priority,
      item.assignees.join(csvListSeparator), item.labels.join(csvListSeparator), item.cycle ?? "", item.modules.join(csvListSeparator), item.parent_key ?? "",
      item.start_date ?? "", item.due_date ?? "", item.created_at, item.updated_at, item.completed_at ?? "", item.archived_at ?? "",
    ]));
  }
  return text;
}

const contentTypes = { csv: "text/csv; charset=utf-8", json: "application/json; charset=utf-8", zip: "application/zip" } as const;

export interface ExportRuntime {
  storage?: ExportStorage;
  now?: () => Date;
  maxBytes?: () => number;
}

/** Projects of a workspace the user belongs to (a project member row), by id. */
async function memberProjects(db: Database, userId: string, workspaceId: string, ids: string[]) {
  if (ids.length === 0) return [];
  return db.select({ id: projects.id, key: projects.key, name: projects.name }).from(projects)
    .innerJoin(projectMembers, and(eq(projectMembers.projectId, projects.id), eq(projectMembers.userId, userId)))
    .where(and(eq(projects.workspaceId, workspaceId), inArray(projects.id, ids)));
}

/** Every project of a workspace the user belongs to. */
async function allMemberProjects(db: Database, userId: string, workspaceId: string) {
  return db.select({ id: projects.id, key: projects.key, name: projects.name }).from(projects)
    .innerJoin(projectMembers, and(eq(projectMembers.projectId, projects.id), eq(projectMembers.userId, userId)))
    .where(eq(projects.workspaceId, workspaceId));
}

/** The `export_build` job: builds the file, stores it, and records the outcome on the Export. */
export async function handleExportJob(db: Database, payload: { exportId: string }, job: { id: string }, runtime: ExportRuntime = {}) {
  const now = runtime.now ?? (() => new Date());
  const [row] = await db.select().from(exportTable).where(eq(exportTable.id, payload.exportId));
  if (!row || row.status === "completed" || row.status === "failed") return;
  await db.update(exportTable).set({ status: "processing" }).where(eq(exportTable.id, row.id));
  try {
    // The owner's rights are checked again here: a person who lost the role or a project in between gets no file.
    const role = await requireWorkspaceRole(db, row.ownerId, row.workspaceId, "write").catch(() => null);
    const allowed = role ? await memberProjects(db, row.ownerId, row.workspaceId, row.projectIds) : [];
    if (allowed.length !== row.projectIds.length) throw new ExportFailure("You no longer have access to the chosen project");
    const format = row.format as "csv" | "json";
    const limit = (runtime.maxBytes ?? (() => maxExportBytes()))();
    const budget = { left: limit, limit };
    // One project gives its file as it is; several give a ZIP with one file per project, named by project key.
    const files: Array<{ name: string; data: Uint8Array }> = [];
    for (const project of [...allowed].sort((a, b) => a.key.localeCompare(b.key))) {
      files.push({ name: `${project.key}.${format}`, data: new TextEncoder().encode(renderItems(await collectProjectItems(db, project), format, budget)) });
    }
    const zipped = files.length > 1;
    const key = `${row.workspaceId}/exports/${row.id}.${zipped ? "zip" : format}`;
    const body = zipped ? createZip(files, now()) : files[0]!.data;
    await (runtime.storage ?? createS3Storage()).put(key, body, contentTypes[zipped ? "zip" : format]);
    await db.update(exportTable).set({ status: "completed", fileKey: key, fileSize: body.byteLength, completedAt: now(), failureReason: null }).where(eq(exportTable.id, row.id));
  } catch (error) {
    if (error instanceof ExportFailure) {
      await db.update(exportTable).set({ status: "failed", failureReason: error.message }).where(eq(exportTable.id, row.id));
      return;
    }
    // Anything else (storage, database) is retried by the queue; the last attempt leaves the Export failed.
    const [self] = await db.select({ attempts: jobs.attempts, maxAttempts: jobs.maxAttempts }).from(jobs).where(eq(jobs.id, job.id));
    const last = !self || self.attempts >= self.maxAttempts;
    await db.update(exportTable).set(last ? { status: "failed", failureReason: "The file could not be built. Try again." } : { status: "queued" }).where(eq(exportTable.id, row.id));
    throw error;
  }
}

const exportOutput = Type.Object({
  id: Type.String(), workspaceId: Type.String(), projectIds: Type.Array(Type.String()),
  projects: Type.Array(Type.Object({ id: Type.String(), key: Type.String(), name: Type.String() })),
  format: Type.Union([Type.Literal("csv"), Type.Literal("json")]),
  status: Type.Union([Type.Literal("queued"), Type.Literal("processing"), Type.Literal("completed"), Type.Literal("failed")]),
  failureReason: nullable(Type.String()), size: nullable(Type.Number()), createdAt: Type.String(), completedAt: nullable(Type.String()),
});
type ExportRow = typeof exportTable.$inferSelect;
class DuplicateExport extends Error {}

export function createExportActions(db: Database, runtime: ExportRuntime = {}) {
  let lazyStorage = runtime.storage;
  const store = () => (lazyStorage ??= createS3Storage());
  const now = runtime.now ?? (() => new Date());

  async function out(rows: ExportRow[]) {
    const ids = [...new Set(rows.flatMap((row) => row.projectIds))];
    const found = ids.length ? await db.select({ id: projects.id, key: projects.key, name: projects.name }).from(projects).where(inArray(projects.id, ids)) : [];
    const byId = new Map(found.map((project) => [project.id, project]));
    return rows.map((row) => ({
      id: row.id, workspaceId: row.workspaceId, projectIds: row.projectIds, projects: row.projectIds.flatMap((id) => byId.get(id) ?? []),
      format: row.format as "csv" | "json", status: row.status as "queued" | "processing" | "completed" | "failed", failureReason: row.failureReason, size: row.fileSize,
      createdAt: row.createdAt.toISOString(), completedAt: row.completedAt?.toISOString() ?? null,
    }));
  }

  /** An Export is its owner's alone: anyone else, including an Admin, sees it as missing. */
  async function loadOwn(userId: string, exportId: string) {
    const [row] = await db.select().from(exportTable).where(and(eq(exportTable.id, exportId), eq(exportTable.ownerId, userId)));
    if (!row) throw new ActionError("Export not found", 404);
    await requireWorkspaceRole(db, userId, row.workspaceId, "write");
    return row;
  }

  return {
    requestExport: {
      name: "request_export", kind: "write" as const,
      input: Type.Object({
        workspaceId: uuid(),
        /** Projects the caller belongs to; none means every project the caller belongs to. */
        projectIds: Type.Optional(Type.Array(uuid())),
        format: Type.Optional(Type.Union([Type.Literal("csv"), Type.Literal("json")])),
      }),
      output: exportOutput,
      handler: async (context: { userId: string }, input: { workspaceId: string; projectIds?: string[]; format?: "csv" | "json" }) => {
        await requireWorkspaceRole(db, context.userId, input.workspaceId, "write");
        const chosen = [...new Set(input.projectIds ?? [])].sort();
        const allowed = chosen.length ? await memberProjects(db, context.userId, input.workspaceId, chosen) : await allMemberProjects(db, context.userId, input.workspaceId);
        // A project the caller does not belong to reads as missing, so a private project is not revealed.
        if (chosen.length && allowed.length !== chosen.length) throw new ActionError("Project not found", 404);
        // The stored choice is always the concrete list, so the dedupe key of "all" follows the projects the caller has now.
        const projectIds = allowed.map((project) => project.id).sort();
        if (projectIds.length === 0) throw new ActionError("You do not belong to any project", 400);
        const format = input.format ?? "csv";
        const exportId = crypto.randomUUID();
        try {
          const created = await db.transaction(async (transaction) => {
            const database = transaction as unknown as Database;
            const [row] = await database.insert(exportTable).values({ id: exportId, workspaceId: input.workspaceId, ownerId: context.userId, projectIds, format }).returning();
            const jobId = await enqueueJob(database, { type: exportJobType, payload: { exportId }, dedupeKey: `export:${context.userId}:${input.workspaceId}:${format}:${projectIds.join(",")}` });
            if (!jobId) throw new DuplicateExport();
            return row!;
          });
          return (await out([created]))[0]!;
        } catch (error) {
          if (!(error instanceof DuplicateExport)) throw error;
          // The same choice is already queued or running: report that Export instead of starting another.
          const [open] = await db.select().from(exportTable).where(and(
            eq(exportTable.ownerId, context.userId), eq(exportTable.workspaceId, input.workspaceId), eq(exportTable.format, format),
            sql`${exportTable.projectIds} = ${JSON.stringify(projectIds)}::jsonb`, inArray(exportTable.status, ["queued", "processing"]),
          )).orderBy(desc(exportTable.createdAt)).limit(1);
          if (!open) throw new ActionError("An Export of this choice is already being prepared", 409);
          return (await out([open]))[0]!;
        }
      },
    },
    listExports: {
      name: "list_exports", kind: "read" as const,
      input: Type.Object({ workspaceId: uuid() }), output: Type.Array(exportOutput),
      handler: async (context: { userId: string }, input: { workspaceId: string }) => {
        await requireWorkspaceRole(db, context.userId, input.workspaceId, "write");
        const rows = await db.select().from(exportTable)
          .where(and(eq(exportTable.workspaceId, input.workspaceId), eq(exportTable.ownerId, context.userId))).orderBy(desc(exportTable.createdAt), desc(exportTable.id));
        return out(rows);
      },
    },
    getExportDownloadUrl: {
      name: "get_export_download_url", kind: "read" as const,
      input: Type.Object({ exportId: uuid() }),
      output: Type.Object({ url: Type.String(), filename: Type.String(), expiresAt: Type.String() }),
      handler: async (context: { userId: string }, input: { exportId: string }) => {
        const row = await loadOwn(context.userId, input.exportId);
        if (row.status !== "completed" || !row.fileKey || !row.completedAt) throw new ActionError("The Export is not ready", 409);
        const expiresAt = new Date(row.completedAt.getTime() + exportLinkTtlMs);
        const remainingSeconds = Math.floor((expiresAt.getTime() - now().getTime()) / 1000);
        if (remainingSeconds <= 0) throw new ActionError("The Export has expired", 410);
        const day = row.completedAt.toISOString().slice(0, 10);
        // One project gives its own file, several give a ZIP.
        const zipped = row.projectIds.length > 1;
        const [project] = zipped ? [] : await out([row]).then((rows) => rows[0]!.projects);
        const extension = zipped ? "zip" : row.format;
        const filename = `${project?.key ?? "export"}-work-items-${day}.${extension}`.replace(/^export-work-items/, "work-items");
        const { url } = await store().presignGet({ key: row.fileKey, filename, contentType: contentTypes[extension as keyof typeof contentTypes], inline: false, expiresInSeconds: remainingSeconds });
        return { url, filename, expiresAt: expiresAt.toISOString() };
      },
    },
  };
}
