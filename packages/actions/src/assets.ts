import { Type } from "@sinclair/typebox";
import { and, asc, eq, isNull } from "drizzle-orm";
import type { Database } from "@weft/db";
import { activities, assets, comments, cycles, modules, runs, wikiPages, workItems } from "@weft/db";
import { assertNotArchived, liveWorkItems } from "./triage";
import { intakeItems } from "@weft/db";
import { ActionError, requireWorkspaceRole } from "./members";
import { requireProjectAccess } from "./projects";
import { activityActor, type ActivityContext } from "./work-items";
import { createS3Storage, inlineImageTypes, maxAssetBytes, type AssetStorage } from "./storage";
import { assertFeatureEnabled } from "./features";
import { requireWikiPageAccess } from "./wiki";

type Context = ActivityContext & { agent?: ActivityContext["agent"] & { workspaceId?: string } };
type AssetRow = typeof assets.$inferSelect;

const uuid = () => Type.String({ format: "uuid" });
type OwnerType = "work_item" | "comment" | "wiki_page" | "cycle" | "module";
const ownerType = Type.Union([Type.Literal("work_item"), Type.Literal("comment"), Type.Literal("wiki_page"), Type.Literal("cycle"), Type.Literal("module")]);
const assetOutput = Type.Object({
  id: Type.String(), ownerType, ownerId: Type.String(), uploaderId: Type.String(), filename: Type.String(), contentType: Type.String(),
  size: Type.Number(), inline: Type.Boolean(), createdAt: Type.String(),
});
const uploadOutput = Type.Object({ assetId: Type.String(), url: Type.String(), fields: Type.Record(Type.String(), Type.String()), maxBytes: Type.Number() });
const downloadOutput = Type.Object({ url: Type.String(), filename: Type.String(), contentType: Type.String(), inline: Type.Boolean() });

export const isInlineImage = (contentType: string) => (inlineImageTypes as readonly string[]).includes(contentType);

/** Browsers send parameters ("image/png; charset=x") and any case; normalise before comparing. */
function normaliseType(raw: string) {
  const type = raw.split(";")[0]!.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(type) ? type : "application/octet-stream";
}

function cleanFilename(raw: string) {
  const name = raw.replace(/[\\/\u0000-\u001f]/g, "_").trim().slice(0, 255);
  return name === "" || name === "." || name === ".." ? "file" : name;
}

export function createAssetActions(db: Database, storage?: AssetStorage, limitBytes: () => number = () => maxAssetBytes()) {
  let lazyStorage = storage;
  const store = () => (lazyStorage ??= createS3Storage());

  type Owner = { workspaceId: string; projectId: string | null; workItemId: string | null; wikiPageId: string | null; archivedAt?: Date | null };

  async function resolveOwner(type: OwnerType, id: string): Promise<Owner> {
    if (type === "work_item") {
      // Intake work items deliberately stay out of normal reads, but their assets
      // must resolve through this owner path while they are in Triage.
      const [item] = await db.select().from(workItems).where(and(eq(workItems.id, id), isNull(workItems.deletedAt)));
      if (!item) throw new ActionError("Owner not found", 404);
      return { workspaceId: item.workspaceId, projectId: item.projectId, workItemId: item.id, wikiPageId: null };
    }
    if (type === "wiki_page") {
      const [page] = await db.select().from(wikiPages).where(and(eq(wikiPages.id, id), isNull(wikiPages.deletedAt)));
      if (!page) throw new ActionError("Owner not found", 404);
      return { workspaceId: page.workspaceId, projectId: page.projectId, workItemId: null, wikiPageId: page.id };
    }
    if (type === "cycle" || type === "module") {
      const table = type === "cycle" ? cycles : modules;
      const [entity] = await db.select().from(table).where(and(eq(table.id, id), isNull(table.deletedAt)));
      if (!entity) throw new ActionError("Owner not found", 404);
      return { workspaceId: entity.workspaceId, projectId: entity.projectId, workItemId: null, wikiPageId: null, archivedAt: entity.archivedAt };
    }
    const [comment] = await db.select().from(comments).where(and(eq(comments.id, id), isNull(comments.deletedAt)));
    if (!comment) throw new ActionError("Owner not found", 404);
    return { workspaceId: comment.workspaceId, projectId: comment.projectId, workItemId: comment.workItemId, wikiPageId: comment.wikiPageId };
  }

  /** Project owners follow project access; wiki pages follow the wiki rule: public to every member, private to the page owner (others see it missing). */
  async function requireOwnerAccess(owner: Owner, userId: string, level: "read" | "write" | "admin", database: Database = db) {
    if (owner.wikiPageId) return requireWikiPageAccess(database, userId, owner.wikiPageId, level === "read" ? "read" : "write");
    if (owner.projectId) {
      const intake = owner.workItemId ? (await database.select().from(intakeItems).where(eq(intakeItems.workItemId, owner.workItemId)))[0] : undefined;
      if (intake && intake.outcome !== "accepted") {
        const { project, workspaceRole, projectRole } = await requireProjectAccess(database, userId, owner.projectId, "read");
        assertFeatureEnabled(project, "intake");
        const admin = workspaceRole === "Admin" || projectRole === "Admin";
        if (level === "read") {
          if (workspaceRole !== "Admin" && (workspaceRole === "Guest" || projectRole === "Guest") && intake.createdBy !== userId) throw new ActionError("Asset not found", 404);
          return;
        }
        if (intake.outcome !== "pending" && intake.outcome !== "snoozed") throw new ActionError("Intake item is read-only", 400);
        if (project.archivedAt) throw new ActionError("Project is archived", 400);
        if (level === "admin") {
          if (!admin) throw new ActionError("Forbidden", 403);
          return;
        }
        if (!admin && intake.createdBy !== userId) throw new ActionError("Forbidden", 403);
        return;
      }
      return requireProjectAccess(database, userId, owner.projectId, level);
    }
    await requireWorkspaceRole(database, userId, owner.workspaceId, "read");
    if (level !== "read") await requireWorkspaceRole(database, userId, owner.workspaceId, level);
  }

  /** An archived work item is read-only, and so are the files on it and on its comments. */
  async function assertOwnerOpen(owner: Owner | null, database: Database = db) {
    if (!owner) return;
    if (owner.archivedAt) throw new ActionError("This archived item is read-only", 400);
    if (!owner.workItemId) return;
    const [item] = await database.select({ archivedAt: workItems.archivedAt }).from(workItems).where(eq(workItems.id, owner.workItemId));
    if (item) assertNotArchived(item);
  }

  async function requireRowAccess(row: AssetRow, userId: string, level: "read" | "write" | "admin") {
    if (row.ownerType === "wiki_page") return requireOwnerAccess(await resolveOwner("wiki_page", row.ownerId), userId, level);
    if (row.ownerType === "comment") {
      // A comment on a wiki page follows the page, not just the project the page lives in.
      const owner = await resolveOwner("comment", row.ownerId);
      if (owner.wikiPageId || owner.workItemId) return requireOwnerAccess(owner, userId, level);
    }
    if (row.ownerType === "work_item") return requireOwnerAccess(await resolveOwner("work_item", row.ownerId), userId, level);
    if (row.projectId) return requireProjectAccess(db, userId, row.projectId, level);
    await requireOwnerAccess(await resolveOwner(row.ownerType as OwnerType, row.ownerId), userId, level);
  }

  async function loadAsset(assetId: string) {
    const [row] = await db.select().from(assets).where(eq(assets.id, assetId));
    if (!row) throw new ActionError("Asset not found", 404);
    return row;
  }

  /** A Runtime Run may deliver files only to the Work item it is executing. */
  async function assertRunWorkItem(context: Context, ownerType: OwnerType, ownerId: string) {
    if (!context.agent) return;
    if (ownerType !== "work_item") throw new ActionError("An Agent can attach files only to its Run's Work item", 403);
    const [run] = await db.select({ workItemId: runs.workItemId, workspaceId: runs.workspaceId }).from(runs).where(eq(runs.id, context.agent.runId));
    if (!run || !run.workItemId || run.workItemId !== ownerId || (context.agent.workspaceId && run.workspaceId !== context.agent.workspaceId)) {
      throw new ActionError("An Agent can attach files only to its Run's Work item", 403);
    }
  }

  const out = (row: AssetRow) => ({
    id: row.id, ownerType: row.ownerType as OwnerType, ownerId: row.ownerId, uploaderId: row.uploaderId, filename: row.filename,
    contentType: row.contentType, size: row.size, inline: isInlineImage(row.contentType), createdAt: row.createdAt.toISOString(),
  });

  return {
    requestAssetUpload: {
      name: "request_asset_upload", kind: "write" as const,
      input: Type.Object({ ownerType, ownerId: uuid(), filename: Type.String({ minLength: 1, maxLength: 255 }), contentType: Type.String({ minLength: 1, maxLength: 255 }), size: Type.Integer({ minimum: 1 }) }),
      output: uploadOutput,
      handler: async (context: Context, input: { ownerType: OwnerType; ownerId: string; filename: string; contentType: string; size: number }) => {
        await assertRunWorkItem(context, input.ownerType, input.ownerId);
        const owner = await resolveOwner(input.ownerType, input.ownerId);
        await requireOwnerAccess(owner, context.userId, "write");
        await assertOwnerOpen(owner);
        const maxBytes = limitBytes();
        if (input.size > maxBytes) throw new ActionError(`File exceeds the ${maxBytes} byte limit`, 413);
        const contentType = normaliseType(input.contentType);
        const assetId = crypto.randomUUID();
        const storageKey = `${owner.workspaceId}/${assetId}`;
        const post = await store().presignPost({ key: storageKey, contentType, maxBytes });
        await db.insert(assets).values({
          id: assetId, workspaceId: owner.workspaceId, projectId: owner.projectId, ownerType: input.ownerType, ownerId: input.ownerId,
          uploaderId: context.userId, storageKey, filename: cleanFilename(input.filename), contentType, size: input.size,
        });
        return { assetId, url: post.url, fields: post.fields, maxBytes };
      },
    },
    completeAssetUpload: {
      name: "complete_asset_upload", kind: "write" as const,
      input: Type.Object({ assetId: uuid() }), output: assetOutput,
      handler: async (context: Context, input: { assetId: string }) => {
        const row = await loadAsset(input.assetId);
        await assertRunWorkItem(context, row.ownerType as OwnerType, row.ownerId);
        await requireRowAccess(row, context.userId, "write");
        if (row.uploaderId !== context.userId) throw new ActionError("Only the uploader can complete an upload", 403);
        const owner = await resolveOwner(row.ownerType as OwnerType, row.ownerId);
        const result = await db.transaction(async (transaction) => {
          const database = transaction as unknown as Database;
          // Intake decisions take this lock first. Recheck access after it, so
          // a rejection or acceptance cannot race a previously authorized upload.
          if (owner.workItemId) {
            await database.select({ id: intakeItems.id }).from(intakeItems).where(eq(intakeItems.workItemId, owner.workItemId)).for("update");
            await requireOwnerAccess(owner, context.userId, "write", database);
          }
          // Completion and cancellation must serialize before touching storage;
          // otherwise cancellation can remove bytes belonging to an uploaded row.
          const [locked] = await database.select().from(assets).where(eq(assets.id, row.id)).for("update");
          if (!locked) throw new ActionError("Asset not found", 404);
          if (locked.status === "uploaded") return { asset: out(locked) };
          const stored = await store().head(locked.storageKey);
          if (!stored) throw new ActionError("File was not uploaded", 400);
          if (stored.size < 1 || stored.size > limitBytes()) {
            await store().remove(locked.storageKey);
            await database.delete(assets).where(eq(assets.id, locked.id));
            return { oversize: true as const };
          }
          const [updated] = await database.update(assets).set({ status: "uploaded", size: stored.size, uploadedAt: new Date() }).where(eq(assets.id, row.id)).returning();
          if (owner.workItemId && owner.projectId) {
            await database.insert(activities).values({
              workspaceId: owner.workspaceId, projectId: owner.projectId, entityType: "work_item", entityId: owner.workItemId, field: "attachment_added",
              newValue: { assetId: row.id, filename: row.filename, ownerType: row.ownerType }, ...activityActor(context),
            });
          }
          return { asset: out(updated!) };
        });
        if (result.oversize) throw new ActionError("File exceeds the size limit", 413);
        return result.asset!;
      },
    },
    cancelAssetUpload: {
      name: "cancel_asset_upload", kind: "write" as const,
      input: Type.Object({ assetId: uuid() }), output: Type.Object({ ok: Type.Boolean() }),
      handler: async (context: Context, input: { assetId: string }) => {
        return db.transaction(async (transaction) => {
          const database = transaction as unknown as Database;
          const [row] = await database.select().from(assets).where(eq(assets.id, input.assetId)).for("update");
          if (!row || row.uploaderId !== context.userId || row.status !== "pending") throw new ActionError("Pending upload not found", 404);
          // The uploader may discard their unfinished upload after losing access.
          await store().remove(row.storageKey);
          await database.delete(assets).where(eq(assets.id, row.id));
          return { ok: true };
        });
      },
    },
    listAssets: {
      name: "list_assets", kind: "read" as const,
      input: Type.Object({ ownerType, ownerId: uuid() }), output: Type.Array(assetOutput),
      handler: async (context: Context, input: { ownerType: OwnerType; ownerId: string }) => {
        const owner = await resolveOwner(input.ownerType, input.ownerId);
        await requireOwnerAccess(owner, context.userId, "read");
        const rows = await db.select().from(assets)
          .where(and(eq(assets.ownerType, input.ownerType), eq(assets.ownerId, input.ownerId), eq(assets.status, "uploaded"))).orderBy(asc(assets.createdAt), asc(assets.id));
        return rows.map(out);
      },
    },
    getAssetDownloadUrl: {
      name: "get_asset_download_url", kind: "read" as const,
      input: Type.Object({ assetId: uuid(), download: Type.Optional(Type.Boolean()) }), output: downloadOutput,
      handler: async (context: Context, input: { assetId: string; download?: boolean }) => {
        const row = await loadAsset(input.assetId);
        await requireRowAccess(row, context.userId, "read");
        if (row.status !== "uploaded") throw new ActionError("Asset not found", 404);
        const inline = !input.download && isInlineImage(row.contentType);
        const { url } = await store().presignGet({ key: row.storageKey, filename: row.filename, contentType: row.contentType, inline });
        return { url, filename: row.filename, contentType: row.contentType, inline };
      },
    },
    deleteAsset: {
      name: "delete_asset", kind: "write" as const,
      input: Type.Object({ assetId: uuid() }), output: Type.Object({ ok: Type.Boolean() }),
      handler: async (context: Context, input: { assetId: string }) => {
        const row = await loadAsset(input.assetId);
        await requireRowAccess(row, context.userId, row.uploaderId === context.userId ? "write" : "admin");
        const owner = await resolveOwner(row.ownerType as OwnerType, row.ownerId).catch(() => null);
        await assertOwnerOpen(owner);
        await db.transaction(async (transaction) => {
          const database = transaction as unknown as Database;
          if (owner?.workItemId) {
            // Decisions and uploads take the Intake lock before the asset lock.
            await database.select({ id: intakeItems.id }).from(intakeItems).where(eq(intakeItems.workItemId, owner.workItemId)).for("update");
            await requireOwnerAccess(owner, context.userId, row.uploaderId === context.userId ? "write" : "admin", database);
            await assertOwnerOpen(owner, database);
          }
          const [locked] = await database.select().from(assets).where(eq(assets.id, row.id)).for("update");
          if (!locked) throw new ActionError("Asset not found", 404);
          await store().remove(locked.storageKey);
          await database.delete(assets).where(eq(assets.id, row.id));
          if (owner?.workItemId && owner.projectId) {
            await database.insert(activities).values({
              workspaceId: owner.workspaceId, projectId: owner.projectId, entityType: "work_item", entityId: owner.workItemId, field: "attachment_removed",
              oldValue: { assetId: row.id, filename: row.filename, ownerType: row.ownerType }, ...activityActor(context),
            });
          }
        });
        return { ok: true };
      },
    },
  };
}
