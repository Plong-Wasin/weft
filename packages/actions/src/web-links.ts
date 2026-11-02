import { Type } from "@sinclair/typebox";
import { and, asc, eq } from "drizzle-orm";
import type { Database } from "@weft/db";
import { activities, webLinks, workItems } from "@weft/db";
import { assertNotArchived, liveWorkItems } from "./triage";
import { ActionError } from "./members";
import { requireProjectAccess } from "./projects";
import { activityActor, type ActivityContext } from "./work-items";

type Context = ActivityContext;
const uuid = () => Type.String({ format: "uuid" });
const fields = { workItemId: uuid(), url: Type.String({ minLength: 1, maxLength: 2048 }), title: Type.Optional(Type.Union([Type.String({ maxLength: 500 }), Type.Null()])) };
const output = Type.Object({ id: Type.String(), workItemId: Type.String(), url: Type.String(), title: Type.Union([Type.String(), Type.Null()]), createdAt: Type.String(), updatedAt: Type.String() });
type Row = typeof webLinks.$inferSelect;

export function createWebLinkActions(db: Database) {
  const out = (row: Row) => ({ id: row.id, workItemId: row.workItemId, url: row.url, title: row.title, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() });
  async function item(id: string) {
    const [row] = await db.select().from(workItems).where(and(eq(workItems.id, id), liveWorkItems));
    if (!row) throw new ActionError("Work item not found", 404);
    return row;
  }
  async function log(database: Database, context: Context, row: Row, field: string, oldValue?: unknown, newValue?: unknown) {
    await database.insert(activities).values({ workspaceId: row.workspaceId, projectId: row.projectId, entityType: "work_item", entityId: row.workItemId, field, ...(oldValue === undefined ? {} : { oldValue }), ...(newValue === undefined ? {} : { newValue }), ...activityActor(context) });
  }
  /** The work item of a write: refused once it is archived. */
  async function writable(id: string) { const row = await item(id); assertNotArchived(row); return row; }
  function validateUrl(raw: string) {
    const value = raw.trim();
    try { const url = new URL(value); if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname) throw new Error(); }
    catch { throw new ActionError("Web Link URL must be an http(s) URL", 400); }
    return value;
  }
  return {
    listWebLinks: { name: "list_web_links", kind: "read" as const, input: Type.Object({ workItemId: uuid() }), output: Type.Array(output), handler: async (context: Context, input: { workItemId: string }) => { const work = await item(input.workItemId); await requireProjectAccess(db, context.userId, work.projectId, "read"); return (await db.select().from(webLinks).where(eq(webLinks.workItemId, work.id)).orderBy(asc(webLinks.createdAt), asc(webLinks.id))).map(out); } },
    createWebLink: { name: "create_web_link", kind: "write" as const, input: Type.Object(fields), output, handler: async (context: Context, input: { workItemId: string; url: string; title?: string | null }) => { const work = await writable(input.workItemId); await requireProjectAccess(db, context.userId, work.projectId, "write"); const cleanUrl = validateUrl(input.url); return db.transaction(async (tx) => { const database = tx as unknown as Database; const [row] = await database.insert(webLinks).values({ workspaceId: work.workspaceId, projectId: work.projectId, workItemId: work.id, url: cleanUrl, title: input.title?.trim() || null, createdBy: context.userId }).returning(); await log(database, context, row!, "web_link_added", undefined, { id: row!.id, url: row!.url, title: row!.title }); return out(row!); }); } },
    updateWebLink: { name: "update_web_link", kind: "write" as const, input: Type.Object({ webLinkId: uuid(), url: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })), title: Type.Optional(Type.Union([Type.String({ maxLength: 500 }), Type.Null()])) }), output, handler: async (context: Context, input: { webLinkId: string; url?: string; title?: string | null }) => { const [existing] = await db.select().from(webLinks).where(eq(webLinks.id, input.webLinkId)); if (!existing) throw new ActionError("Web Link not found", 404); await writable(existing.workItemId); await requireProjectAccess(db, context.userId, existing.projectId, "write"); if (input.url === undefined && input.title === undefined) throw new ActionError("Provide a URL or title", 400); const nextUrl = input.url === undefined ? existing.url : validateUrl(input.url); const nextTitle = input.title === undefined ? existing.title : input.title?.trim() || null; return db.transaction(async (tx) => { const database = tx as unknown as Database; const [row] = await database.update(webLinks).set({ url: nextUrl, title: nextTitle, updatedAt: new Date() }).where(eq(webLinks.id, existing.id)).returning(); await log(database, context, row!, "web_link_updated", { url: existing.url, title: existing.title }, { url: row!.url, title: row!.title }); return out(row!); }); } },
    deleteWebLink: { name: "delete_web_link", kind: "write" as const, input: Type.Object({ webLinkId: uuid() }), output: Type.Object({ removed: Type.Boolean() }), handler: async (context: Context, input: { webLinkId: string }) => { const [row] = await db.select().from(webLinks).where(eq(webLinks.id, input.webLinkId)); if (!row) throw new ActionError("Web Link not found", 404); await writable(row.workItemId); await requireProjectAccess(db, context.userId, row.projectId, "write"); return db.transaction(async (tx) => { const database = tx as unknown as Database; await database.delete(webLinks).where(eq(webLinks.id, row.id)); await log(database, context, row, "web_link_removed", { id: row.id, url: row.url, title: row.title }); return { removed: true }; }); } },
  };
}
