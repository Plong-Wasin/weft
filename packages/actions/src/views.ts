import { Type } from "@sinclair/typebox";
import { and, asc, eq } from "drizzle-orm";
import type { Database } from "@weft/db";
import { views } from "@weft/db";
import { ActionError } from "./members";
import { compilePql, weftPqlRegistry } from "./pql";
import { requireProjectAccess } from "./projects";

/** The Layouts a View can store (the glossary's list, board, spreadsheet). */
export const viewLayouts = ["list", "board", "spreadsheet"] as const;
export const viewGroupings = ["none", "state", "priority", "assignee"] as const;
export const viewOrderFields = ["manual", "priority", "title", "created", "updated", "dueDate"] as const;
/** The properties a work item row can show, in the default order. */
export const viewProperties = ["id", "state", "priority", "assignee", "labels", "dates", "cycle", "modules"] as const;
export const viewAccess = ["public", "private"] as const;
export type ViewAccess = (typeof viewAccess)[number];

const literals = <T extends readonly string[]>(values: T) => Type.Union(values.map((value) => Type.Literal(value)) as never) as unknown as ReturnType<typeof Type.String>;
const uuid = () => Type.String({ format: "uuid" });
const nameSchema = Type.String({ minLength: 1, maxLength: 100 });
const propertiesSchema = Type.Array(Type.String({ minLength: 1 }), { maxItems: 20 });
const viewOutput = Type.Object({
  id: Type.String(), projectId: Type.String(), name: Type.String(), description: Type.String(), query: Type.String(),
  layout: Type.String(), groupBy: Type.String(), orderBy: Type.String(), orderDirection: Type.String(), properties: Type.Array(Type.String()),
  access: Type.String(), ownerId: Type.String(), createdAt: Type.String(), updatedAt: Type.String(),
});
type Context = { userId: string };
type ViewRow = typeof views.$inferSelect;
type Fields = { name?: string; description?: string; query?: string; layout?: string; groupBy?: string; orderBy?: string; orderDirection?: string; properties?: string[]; access?: string };

const present = (row: ViewRow) => ({
  id: row.id, projectId: row.projectId, name: row.name, description: row.description, query: row.query, layout: row.layout, groupBy: row.groupBy,
  orderBy: row.orderBy, orderDirection: row.orderDirection, properties: row.properties, access: row.access, ownerId: row.ownerId,
  createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
});

function assertOneOf(value: string | undefined, allowed: readonly string[], label: string) {
  if (value !== undefined && !allowed.includes(value)) throw new ActionError(`Invalid ${label}`, 400);
}

export function createViewActions(db: Database) {
  /** A private View exists only for its owner: to everyone else it is a 404. */
  async function load(userId: string, viewId: string) {
    const [found] = await db.select().from(views).where(eq(views.id, viewId));
    if (!found) throw new ActionError("View not found", 404);
    const access = await requireProjectAccess(db, userId, found.projectId, "read");
    if (found.access === "private" && found.ownerId !== userId) throw new ActionError("View not found", 404);
    return { view: found, ...access };
  }

  /** Validates every given field; the PQL filter is compiled in the project so unknown names fail at save time. */
  async function validate(userId: string, project: { id: string; key: string; workspaceId: string }, fields: Fields) {
    if (fields.name !== undefined && fields.name.trim() === "") throw new ActionError("Name must not be empty", 400);
    assertOneOf(fields.layout, viewLayouts, "layout");
    assertOneOf(fields.groupBy, viewGroupings, "group by");
    assertOneOf(fields.orderBy, viewOrderFields, "order by");
    assertOneOf(fields.orderDirection, ["asc", "desc"], "order direction");
    assertOneOf(fields.access, viewAccess, "access");
    if (fields.properties) {
      for (const property of fields.properties) assertOneOf(property, viewProperties, "property");
      if (new Set(fields.properties).size !== fields.properties.length) throw new ActionError("Properties must not repeat", 400);
    }
    if (fields.query?.trim()) await compilePql(db, { workspaceId: project.workspaceId, projectId: project.id, projectKey: project.key, userId }, fields.query, { registry: weftPqlRegistry });
  }

  const optional = {
    description: Type.Optional(Type.String({ maxLength: 2000 })), query: Type.Optional(Type.String({ maxLength: 4000 })), layout: Type.Optional(literals(viewLayouts)),
    groupBy: Type.Optional(literals(viewGroupings)), orderBy: Type.Optional(literals(viewOrderFields)), orderDirection: Type.Optional(literals(["asc", "desc"] as const)),
    properties: Type.Optional(propertiesSchema), access: Type.Optional(literals(viewAccess)),
  };
  type CreateInput = Fields & { projectId: string; name: string };
  type UpdateInput = Fields & { viewId: string };

  return {
    createView: {
      name: "create_view", kind: "write" as const,
      input: Type.Object({ projectId: uuid(), name: nameSchema, ...optional }), output: viewOutput,
      handler: async (context: Context, input: CreateInput) => {
        const { project } = await requireProjectAccess(db, context.userId, input.projectId, "write");
        await validate(context.userId, project, input);
        const [row] = await db.insert(views).values({
          workspaceId: project.workspaceId, projectId: project.id, name: input.name.trim(), description: input.description ?? "", query: input.query?.trim() ?? "",
          layout: input.layout ?? "list", groupBy: input.groupBy ?? "state", orderBy: input.orderBy ?? "manual", orderDirection: input.orderDirection ?? "asc",
          properties: input.properties ?? [...viewProperties], access: input.access ?? "public", ownerId: context.userId, createdAt: new Date(),
        }).returning();
        return present(row!);
      },
    },
    updateView: {
      name: "update_view", kind: "write" as const,
      input: Type.Object({ viewId: uuid(), name: Type.Optional(nameSchema), ...optional }), output: viewOutput,
      handler: async (context: Context, input: UpdateInput) => {
        const { view, project } = await loadChangeable(context.userId, input.viewId);
        await validate(context.userId, project, input);
        const [row] = await db.update(views).set({
          name: input.name?.trim() ?? view.name, description: input.description ?? view.description, query: input.query === undefined ? view.query : input.query.trim(),
          layout: input.layout ?? view.layout, groupBy: input.groupBy ?? view.groupBy, orderBy: input.orderBy ?? view.orderBy,
          orderDirection: input.orderDirection ?? view.orderDirection, properties: input.properties ?? view.properties, access: input.access ?? view.access, updatedAt: new Date(),
        }).where(eq(views.id, view.id)).returning();
        return present(row!);
      },
    },
    deleteView: {
      name: "delete_view", kind: "write" as const,
      input: Type.Object({ viewId: uuid() }), output: Type.Object({ id: Type.String() }),
      handler: async (context: Context, input: { viewId: string }) => {
        const { view } = await loadChangeable(context.userId, input.viewId);
        await db.delete(views).where(eq(views.id, view.id));
        return { id: view.id };
      },
    },
    /** Public Views plus the caller's own private ones, oldest first. */
    listViews: {
      name: "list_views", kind: "read" as const,
      input: Type.Object({ projectId: uuid() }), output: Type.Array(viewOutput),
      handler: async (context: Context, input: { projectId: string }) => {
        await requireProjectAccess(db, context.userId, input.projectId, "read");
        const rows = await db.select().from(views).where(eq(views.projectId, input.projectId)).orderBy(asc(views.createdAt), asc(views.id));
        return rows.filter((row) => row.access === "public" || row.ownerId === context.userId).map(present);
      },
    },
    getView: {
      name: "get_view", kind: "read" as const,
      input: Type.Object({ viewId: uuid() }), output: viewOutput,
      handler: async (context: Context, input: { viewId: string }) => present((await load(context.userId, input.viewId)).view),
    },
  };

  /** Change and delete: the caller must be able to write in the project (so never a Guest), and be the owner or an Admin. */
  async function loadChangeable(userId: string, viewId: string) {
    const found = await load(userId, viewId);
    await requireProjectAccess(db, userId, found.view.projectId, "write");
    const admin = found.workspaceRole === "Admin" || found.projectRole === "Admin";
    if (found.view.ownerId !== userId && !admin) throw new ActionError("Forbidden", 403);
    return found;
  }
}
