import { Type } from "@sinclair/typebox";
import { and, asc, count, eq, inArray, max, ne, sql } from "drizzle-orm";
import type { Database } from "@weft/db";
import { customPropertyOptions, customPropertyTypes, customProperties, users, workItemPropertyValues, workItemTypes, workItems } from "@weft/db";
import { assertFeatureEnabled } from "./features";
import { ActionError } from "./members";
import { requireProjectAccess } from "./projects";
import { liveWorkItems } from "./triage";
import { logActivity, readablePropertyValue, type ActivityContext } from "./work-items";
import {
  coerceValue, hasValue, loadPropertyValues, loadProperties, loadTypeRow, maxPropertyOptions, propertyActivityField, maxTypesPerProject, optionKinds, propertyKinds, typeIcons, typeSuggestions,
  type PropertyDef, type PropertyKind,
} from "./work-item-properties";

const uuid = () => Type.String({ format: "uuid" });
const projectInput = { projectId: uuid() };
const iconSchema = Type.Union(typeIcons.map((icon) => Type.Literal(icon)));
const colorSchema = Type.String({ pattern: "^#[0-9a-fA-F]{6}$" });
const kindSchema = Type.Union(propertyKinds.map((kind) => Type.Literal(kind)));
const typeName = Type.String({ minLength: 1, maxLength: 40 });
const propertyName = Type.String({ minLength: 1, maxLength: 60 });
const optionLabel = Type.String({ minLength: 1, maxLength: 60 });
const typeOutput = Type.Object({
  id: Type.String(), projectId: Type.String(), name: Type.String(), icon: iconSchema, color: Type.String(), description: Type.String(),
  position: Type.Integer(), workItems: Type.Integer({ description: "How many live work items have this type." }),
});
const optionOutput = Type.Object({ id: Type.String(), label: Type.String(), position: Type.Integer() });
const propertyOutput = Type.Object({
  id: Type.String(), projectId: Type.String(), name: Type.String(), kind: kindSchema, required: Type.Boolean(), defaultValue: Type.Any(),
  position: Type.Integer(), options: Type.Array(optionOutput), typeIds: Type.Array(Type.String()),
});
const suggestionOutput = Type.Object({ key: Type.String(), name: Type.String(), icon: iconSchema, color: colorSchema, description: Type.String() });

type Context = ActivityContext;
type TypeRow = typeof workItemTypes.$inferSelect;

/** Name clashes are checked without regard to case, as the database index does. */
async function assertTypeNameFree(database: Database, projectId: string, name: string, exceptId?: string) {
  const [clash] = await database.select({ id: workItemTypes.id }).from(workItemTypes).where(and(eq(workItemTypes.projectId, projectId), sql`lower(${workItemTypes.name}) = lower(${name})`));
  if (clash && clash.id !== exceptId) throw new ActionError(`A work item type named ${name} already exists in this project`, 409);
}

async function assertPropertyNameFree(database: Database, projectId: string, name: string, exceptId?: string) {
  const [clash] = await database.select({ id: customProperties.id }).from(customProperties).where(and(eq(customProperties.projectId, projectId), sql`lower(${customProperties.name}) = lower(${name})`));
  if (clash && clash.id !== exceptId) throw new ActionError(`A custom property named ${name} already exists in this project`, 409);
}

/** Option labels are unique without regard to case, so an Agent's label always names one option. */
function assertLabelsDistinct(labels: string[]) {
  const keys = labels.map((label) => label.trim().toLowerCase());
  if (new Set(keys).size !== keys.length) throw new ActionError("Option labels must be different from each other", 400);
}

export function createWorkItemTypeActions(db: Database) {
  const tx = (transaction: unknown) => transaction as Database;

  async function typeOut(database: Database, row: TypeRow) {
    const [{ value }] = await database.select({ value: count() }).from(workItems).where(and(eq(workItems.typeId, row.id), liveWorkItems));
    return {
      id: row.id, projectId: row.projectId, name: row.name, icon: row.icon as (typeof typeIcons)[number], color: row.color, description: row.description,
      position: row.position, workItems: value,
    };
  }

  async function propertyOut(database: Database, property: PropertyDef) {
    return {
      id: property.id, projectId: property.projectId, name: property.name, kind: property.kind, required: property.required, defaultValue: property.defaultValue,
      position: property.position, options: property.options.map((option) => ({ id: option.id, label: option.label, position: option.position })), typeIds: property.typeIds,
    };
  }

  async function propertyById(database: Database, propertyId: string) {
    const [row] = await database.select().from(customProperties).where(eq(customProperties.id, propertyId));
    if (!row) throw new ActionError("Custom property not found", 404);
    const [found] = (await loadProperties(database, row.projectId)).filter((property) => property.id === propertyId);
    return { row, property: found! };
  }

  return {
    listWorkItemTypes: {
      name: "list_work_item_types", kind: "read" as const,
      input: Type.Object(projectInput), output: Type.Array(typeOutput),
      handler: async (context: Context, input: { projectId: string }) => {
        await requireProjectAccess(db, context.userId, input.projectId, "read");
        const rows = await db.select().from(workItemTypes).where(eq(workItemTypes.projectId, input.projectId)).orderBy(asc(workItemTypes.position), asc(workItemTypes.name));
        return Promise.all(rows.map((row) => typeOut(db, row)));
      },
    },
    /** Every custom property of the project with its kind, options and the types it belongs to. Read it before setting values. */
    listCustomProperties: {
      name: "list_custom_properties", kind: "read" as const,
      input: Type.Object(projectInput), output: Type.Array(propertyOutput),
      handler: async (context: Context, input: { projectId: string }) => {
        await requireProjectAccess(db, context.userId, input.projectId, "read");
        return Promise.all((await loadProperties(db, input.projectId)).map((property) => propertyOut(db, property)));
      },
    },
    listWorkItemTypeSuggestions: {
      name: "list_work_item_type_suggestions", kind: "read" as const,
      input: Type.Object(projectInput), output: Type.Array(suggestionOutput),
      handler: async (context: Context, input: { projectId: string }) => {
        await requireProjectAccess(db, context.userId, input.projectId, "read");
        return typeSuggestions.map((suggestion) => ({ ...suggestion }));
      },
    },
    createWorkItemType: {
      name: "create_work_item_type", kind: "write" as const,
      input: Type.Object({ ...projectInput, name: typeName, icon: iconSchema, color: colorSchema, description: Type.Optional(Type.String({ maxLength: 200 })) }),
      output: typeOutput,
      handler: async (context: Context, input: { projectId: string; name: string; icon: (typeof typeIcons)[number]; color: string; description?: string }) => {
        const { project } = await requireProjectAccess(db, context.userId, input.projectId, "admin");
        assertFeatureEnabled(project, "types");
        return db.transaction(async (transaction) => {
          const database = tx(transaction);
          await database.execute(sql`select pg_advisory_xact_lock(hashtext(${`types:${project.id}`}))`);
          const [{ value: total }] = await database.select({ value: count() }).from(workItemTypes).where(eq(workItemTypes.projectId, project.id));
          if (total >= maxTypesPerProject) throw new ActionError(`A project has at most ${maxTypesPerProject} work item types`, 400);
          const name = input.name.trim();
          if (name === "") throw new ActionError("A work item type needs a name", 400);
          await assertTypeNameFree(database, project.id, name);
          const [{ value }] = await database.select({ value: max(workItemTypes.position) }).from(workItemTypes).where(eq(workItemTypes.projectId, project.id));
          const [row] = await database.insert(workItemTypes).values({
            workspaceId: project.workspaceId, projectId: project.id, name, icon: input.icon, color: input.color.toLowerCase(), description: (input.description ?? "").trim(), position: (value ?? -1) + 1,
          }).returning();
          return typeOut(database, row!);
        });
      },
    },
    updateWorkItemType: {
      name: "update_work_item_type", kind: "write" as const,
      input: Type.Object({ typeId: uuid(), name: Type.Optional(typeName), icon: Type.Optional(iconSchema), color: Type.Optional(colorSchema), description: Type.Optional(Type.String({ maxLength: 200 })) }),
      output: typeOutput,
      handler: async (context: Context, input: { typeId: string; name?: string; icon?: (typeof typeIcons)[number]; color?: string; description?: string }) => {
        const [current] = await db.select().from(workItemTypes).where(eq(workItemTypes.id, input.typeId));
        if (!current) throw new ActionError("Work item type not found", 404);
        const { project } = await requireProjectAccess(db, context.userId, current.projectId, "admin");
        assertFeatureEnabled(project, "types");
        const name = input.name?.trim();
        if (name !== undefined) {
          if (name === "") throw new ActionError("A work item type needs a name", 400);
          await assertTypeNameFree(db, project.id, name, current.id);
        }
        const [row] = await db.update(workItemTypes).set({
          name: name ?? current.name, icon: input.icon ?? (current.icon as (typeof typeIcons)[number]), color: input.color?.toLowerCase() ?? current.color,
          description: input.description !== undefined ? input.description.trim() : current.description,
        }).where(eq(workItemTypes.id, current.id)).returning();
        return typeOut(db, row!);
      },
    },
    /**
     * Deletes a type. A type in use is refused until its work items move to another type (moveToTypeId). Values of properties the target
     * type lacks are dropped only when dropPropertyValues confirms it, and every moved live work item gets its own Activity.
     */
    deleteWorkItemType: {
      name: "delete_work_item_type", kind: "write" as const,
      input: Type.Object({ typeId: uuid(), moveToTypeId: Type.Optional(uuid()), dropPropertyValues: Type.Optional(Type.Boolean()) }),
      output: Type.Object({ removed: Type.Boolean(), moved: Type.Integer() }),
      handler: async (context: Context, input: { typeId: string; moveToTypeId?: string; dropPropertyValues?: boolean }) => {
        const [current] = await db.select().from(workItemTypes).where(eq(workItemTypes.id, input.typeId));
        if (!current) throw new ActionError("Work item type not found", 404);
        const { project } = await requireProjectAccess(db, context.userId, current.projectId, "admin");
        assertFeatureEnabled(project, "types");
        return db.transaction(async (transaction) => {
          const database = tx(transaction);
          await database.execute(sql`select pg_advisory_xact_lock(hashtext(${`types:${project.id}`}))`);
          const [{ value: total }] = await database.select({ value: count() }).from(workItemTypes).where(eq(workItemTypes.projectId, project.id));
          if (total <= 1) throw new ActionError("A project needs at least one work item type", 400);
          const [{ value: live }] = await database.select({ value: count() }).from(workItems).where(and(eq(workItems.typeId, current.id), liveWorkItems));
          if (live > 0 && !input.moveToTypeId) {
            throw new ActionError(`${live} work item${live === 1 ? " uses" : "s use"} ${current.name}. Move ${live === 1 ? "it" : "them"} to another type first.`, 409);
          }
          const target = input.moveToTypeId
            ? await loadTypeRow(database, project.id, input.moveToTypeId)
            : (await database.select().from(workItemTypes).where(and(eq(workItemTypes.projectId, project.id), ne(workItemTypes.id, current.id))).orderBy(asc(workItemTypes.position)).limit(1))[0]!;
          if (target.id === current.id) throw new ActionError("Move the work items to a different type", 400);
          const targetProperties = new Set((await loadProperties(database, project.id, target.id)).map((property) => property.id));
          const movedItems = await database.select().from(workItems).where(and(eq(workItems.typeId, current.id), liveWorkItems));
          const allProperties = await loadProperties(database, project.id);
          const byId = new Map(allProperties.map((property) => [property.id, property]));
          const dropsByItem = new Map<string, string[]>();
          for (const item of movedItems) {
            const values = await database.select({ propertyId: workItemPropertyValues.propertyId }).from(workItemPropertyValues).where(eq(workItemPropertyValues.workItemId, item.id));
            const dropped = values.map((row) => row.propertyId).filter((id) => !targetProperties.has(id));
            if (dropped.length > 0) dropsByItem.set(item.id, dropped);
          }
          // A moved item must already hold a value for each required property of the target type; the move does not fill them.
          const requiredOfTarget = allProperties.filter((property) => property.required && property.typeIds.includes(target.id));
          if (requiredOfTarget.length > 0 && movedItems.length > 0) {
            const valuesByItem = await loadPropertyValues(database, movedItems.map((item) => item.id));
            const blocked = movedItems.flatMap((item) => {
              const values = new Map((valuesByItem.get(item.id) ?? []).map((entry) => [entry.propertyId, entry.value]));
              const missing = requiredOfTarget.filter((property) => !hasValue(values.get(property.id))).map((property) => `"${property.name}"`);
              return missing.length > 0 ? [`${project.key}-${item.sequence} needs ${missing.join(", ")}`] : [];
            });
            if (blocked.length > 0) {
              throw new ActionError(`${blocked.length === 1 ? "1 work item" : `${blocked.length} work items`} cannot move to ${target.name} until ${blocked.length === 1 ? "its" : "their"} required properties have values: ${blocked.join("; ")}. Fill them first, or move to another type.`, 400);
            }
          }
          const droppedNames = [...new Set([...dropsByItem.values()].flat())].map((id) => byId.get(id)?.name ?? "a property");
          if (droppedNames.length > 0 && input.dropPropertyValues !== true) {
            throw new ActionError(`Moving to ${target.name} drops the values of: ${droppedNames.join(", ")}. Confirm the move to drop them.`, 409);
          }
          for (const item of movedItems) {
            for (const propertyId of dropsByItem.get(item.id) ?? []) {
              await database.delete(workItemPropertyValues).where(and(eq(workItemPropertyValues.workItemId, item.id), eq(workItemPropertyValues.propertyId, propertyId)));
            }
            await logActivity(database, context, { workspaceId: project.workspaceId, projectId: project.id, entityType: "work_item", entityId: item.id, field: "type", oldValue: current.name, newValue: target.name });
          }
          const moved = await database.update(workItems).set({ typeId: target.id }).where(eq(workItems.typeId, current.id)).returning({ id: workItems.id });
          await database.delete(workItemTypes).where(eq(workItemTypes.id, current.id));
          return { removed: true, moved: moved.length };
        });
      },
    },
    createCustomProperty: {
      name: "create_custom_property", kind: "write" as const,
      input: Type.Object({
        ...projectInput, name: propertyName, kind: kindSchema, required: Type.Optional(Type.Boolean()),
        defaultValue: Type.Optional(Type.Any({ description: "A default for new work items of the property's types, in the form the kind takes." })),
        options: Type.Optional(Type.Array(optionLabel, { minItems: 1, maxItems: maxPropertyOptions, description: "Only for dropdown and multi-select: the choices, in order." })),
        typeIds: Type.Array(uuid(), { minItems: 1, maxItems: maxTypesPerProject, description: "The work item types the property belongs to (at least one)." }),
      }),
      output: propertyOutput,
      handler: async (context: Context, input: { projectId: string; name: string; kind: PropertyKind; required?: boolean; defaultValue?: unknown; options?: string[]; typeIds: string[] }) => {
        const { project } = await requireProjectAccess(db, context.userId, input.projectId, "admin");
        assertFeatureEnabled(project, "types");
        const isOption = optionKinds.includes(input.kind);
        if (isOption && (!input.options || input.options.length === 0)) throw new ActionError(`A ${input.kind === "dropdown" ? "dropdown" : "multi-select"} property needs at least one option`, 400);
        if (!isOption && input.options !== undefined) throw new ActionError(`Only dropdown and multi-select properties have options`, 400);
        const labels = (input.options ?? []).map((label) => label.trim());
        if (labels.some((label) => label === "")) throw new ActionError("An option label must not be empty", 400);
        assertLabelsDistinct(labels);
        return db.transaction(async (transaction) => {
          const database = tx(transaction);
          await database.execute(sql`select pg_advisory_xact_lock(hashtext(${`properties:${project.id}`}))`);
          const name = input.name.trim();
          if (name === "") throw new ActionError("A custom property needs a name", 400);
          await assertPropertyNameFree(database, project.id, name);
          const types = await database.select({ id: workItemTypes.id }).from(workItemTypes).where(and(eq(workItemTypes.projectId, project.id), inArray(workItemTypes.id, [...new Set(input.typeIds)])));
          if (types.length !== new Set(input.typeIds).size) throw new ActionError("Work item types must belong to this project", 400);
          const [{ value }] = await database.select({ value: max(customProperties.position) }).from(customProperties).where(eq(customProperties.projectId, project.id));
          const [row] = await database.insert(customProperties).values({
            workspaceId: project.workspaceId, projectId: project.id, name, kind: input.kind, required: input.required ?? false, position: (value ?? -1) + 1,
          }).returning();
          if (labels.length > 0) await database.insert(customPropertyOptions).values(labels.map((label, position) => ({ propertyId: row!.id, label, position })));
          await database.insert(customPropertyTypes).values([...new Set(input.typeIds)].map((typeId) => ({ propertyId: row!.id, typeId })));
          if (input.defaultValue !== undefined && input.defaultValue !== null) {
            const [property] = (await loadProperties(database, project.id)).filter((candidate) => candidate.id === row!.id);
            const value = coerceValue(property!, input.defaultValue, new Set());
            await database.update(customProperties).set({ defaultValue: value ?? null }).where(eq(customProperties.id, row!.id));
          }
          return propertyOut(database, (await loadProperties(database, project.id)).find((candidate) => candidate.id === row!.id)!);
        });
      },
    },
    /**
     * Changes a property. Its kind never changes. `options` is the full ordered list: keep an option by id, add one without id, leave one out
     * to delete it, which is refused while a work item uses it. `typeIds` is the full list of types: a type is removed only while none of its
     * work items holds a value for the property.
     */
    updateCustomProperty: {
      name: "update_custom_property", kind: "write" as const,
      input: Type.Object({
        propertyId: uuid(), name: Type.Optional(propertyName), required: Type.Optional(Type.Boolean()),
        defaultValue: Type.Optional(Type.Any()),
        options: Type.Optional(Type.Array(Type.Object({ id: Type.Optional(uuid()), label: optionLabel }), { minItems: 1, maxItems: maxPropertyOptions })),
        typeIds: Type.Optional(Type.Array(uuid(), { minItems: 1, maxItems: maxTypesPerProject })),
      }),
      output: propertyOutput,
      handler: async (context: Context, input: { propertyId: string; name?: string; required?: boolean; defaultValue?: unknown; options?: Array<{ id?: string; label: string }>; typeIds?: string[] }) => {
        const [found] = await db.select().from(customProperties).where(eq(customProperties.id, input.propertyId));
        if (!found) throw new ActionError("Custom property not found", 404);
        const { project } = await requireProjectAccess(db, context.userId, found.projectId, "admin");
        assertFeatureEnabled(project, "types");
        return db.transaction(async (transaction) => {
          const database = tx(transaction);
          await database.execute(sql`select pg_advisory_xact_lock(hashtext(${`properties:${project.id}`}))`);
          const { property: current } = await propertyById(database, input.propertyId);
          if (input.name !== undefined) {
            const name = input.name.trim();
            if (name === "") throw new ActionError("A custom property needs a name", 400);
            await assertPropertyNameFree(database, project.id, name, current.id);
            await database.update(customProperties).set({ name }).where(eq(customProperties.id, current.id));
          }
          if (input.required !== undefined) await database.update(customProperties).set({ required: input.required }).where(eq(customProperties.id, current.id));
          if (input.options !== undefined) {
            if (!optionKinds.includes(current.kind)) throw new ActionError("Only dropdown and multi-select properties have options", 400);
            const labels = input.options.map((option) => option.label.trim());
            if (labels.some((label) => label === "")) throw new ActionError("An option label must not be empty", 400);
            assertLabelsDistinct(labels);
            const known = new Set(current.options.map((option) => option.id));
            const kept = new Set<string>();
            for (const option of input.options) {
              if (!option.id) continue;
              if (!known.has(option.id)) throw new ActionError("Option not found in this property", 400);
              if (kept.has(option.id)) throw new ActionError("An option is listed twice", 400);
              kept.add(option.id);
            }
            for (const option of current.options.filter((entry) => !kept.has(entry.id))) {
              if (current.defaultValue === option.id || (Array.isArray(current.defaultValue) && current.defaultValue.includes(option.id))) {
                throw new ActionError(`Option "${option.label}" is the default for this property; change the default first`, 409);
              }
              const [{ value: used }] = await database.select({ value: count() }).from(workItemPropertyValues)
                .where(and(eq(workItemPropertyValues.propertyId, current.id), sql`(${workItemPropertyValues.value} = to_jsonb(${option.id}::text) or ${workItemPropertyValues.value} @> to_jsonb(${option.id}::text))`));
              if (used > 0) throw new ActionError(`Option "${option.label}" is used by ${used} work item${used === 1 ? "" : "s"}; clear it on them first`, 409);
              await database.delete(customPropertyOptions).where(eq(customPropertyOptions.id, option.id));
            }
            for (const [position, option] of input.options.entries()) {
              if (option.id) await database.update(customPropertyOptions).set({ label: labels[position]!, position }).where(eq(customPropertyOptions.id, option.id));
              else await database.insert(customPropertyOptions).values({ propertyId: current.id, label: labels[position]!, position });
            }
          }
          if (input.typeIds !== undefined) {
            const wanted = [...new Set(input.typeIds)];
            const types = await database.select({ id: workItemTypes.id, name: workItemTypes.name }).from(workItemTypes).where(and(eq(workItemTypes.projectId, project.id), inArray(workItemTypes.id, wanted)));
            if (types.length !== wanted.length) throw new ActionError("Work item types must belong to this project", 400);
            for (const typeId of current.typeIds.filter((id) => !wanted.includes(id))) {
              const [{ value: holding }] = await database.select({ value: count() }).from(workItemPropertyValues)
                .innerJoin(workItems, eq(workItems.id, workItemPropertyValues.workItemId))
                .where(and(eq(workItemPropertyValues.propertyId, current.id), eq(workItems.typeId, typeId), liveWorkItems));
              if (holding > 0) {
                const typeName = (await database.select({ name: workItemTypes.name }).from(workItemTypes).where(eq(workItemTypes.id, typeId)))[0]?.name ?? "this type";
                throw new ActionError(`${holding} work item${holding === 1 ? " of" : "s of"} ${typeName} ${holding === 1 ? "has" : "have"} a value for ${current.name}; clear ${holding === 1 ? "it" : "them"} first`, 409);
              }
            }
            await database.delete(customPropertyTypes).where(eq(customPropertyTypes.propertyId, current.id));
            await database.insert(customPropertyTypes).values(wanted.map((typeId) => ({ propertyId: current.id, typeId })));
          }
          if (input.defaultValue !== undefined) {
            const { property: fresh } = await propertyById(database, current.id);
            const value = coerceValue(fresh, input.defaultValue, new Set());
            await database.update(customProperties).set({ defaultValue: value ?? null }).where(eq(customProperties.id, current.id));
          }
          const { property } = await propertyById(database, current.id);
          return propertyOut(database, property);
        });
      },
    },
    /** Deletes a property and its values on every work item (each live item gets an Activity). */
    deleteCustomProperty: {
      name: "delete_custom_property", kind: "write" as const,
      input: Type.Object({ propertyId: uuid() }), output: Type.Object({ removed: Type.Boolean(), cleared: Type.Integer() }),
      handler: async (context: Context, input: { propertyId: string }) => {
        const [found] = await db.select().from(customProperties).where(eq(customProperties.id, input.propertyId));
        if (!found) throw new ActionError("Custom property not found", 404);
        const { project } = await requireProjectAccess(db, context.userId, found.projectId, "admin");
        assertFeatureEnabled(project, "types");
        return db.transaction(async (transaction) => {
          const database = tx(transaction);
          const { row, property } = await propertyById(database, input.propertyId);
          const held = await database.select({ workItemId: workItemPropertyValues.workItemId, value: workItemPropertyValues.value, deletedAt: workItems.deletedAt, archivedAt: workItems.archivedAt })
            .from(workItemPropertyValues).innerJoin(workItems, eq(workItems.id, workItemPropertyValues.workItemId))
            .where(eq(workItemPropertyValues.propertyId, row.id));
          let cleared = 0;
          // The property is about to go, so its option labels and member names are resolved now and the log keeps the words.
          const memberIds = property.kind === "person" ? held.flatMap((entry) => (Array.isArray(entry.value) ? entry.value : [entry.value]).filter((value): value is string => typeof value === "string")) : [];
          const names = new Map((memberIds.length ? await database.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, memberIds)) : []).map((user) => [user.id, user.name]));
          for (const entry of held) {
            if (entry.deletedAt === null) {
              cleared += 1;
              await logActivity(database, context, { workspaceId: row.workspaceId, projectId: row.projectId, entityType: "work_item", entityId: entry.workItemId, field: propertyActivityField(row.id, property.name), oldValue: readablePropertyValue(property, entry.value, names), newValue: null });
            }
          }
          await database.delete(customProperties).where(eq(customProperties.id, row.id));
          return { removed: true, cleared };
        });
      },
    },
  };
}

