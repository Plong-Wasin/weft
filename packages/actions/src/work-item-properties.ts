import { and, asc, eq, inArray } from "drizzle-orm";
import type { Database } from "@weft/db";
import { customPropertyOptions, customPropertyTypes, customProperties, workItemPropertyValues, workItemTypes } from "@weft/db";
import { ActionError } from "./members";

/** The data kinds a custom property can hold. Stored as JSON: text, number, ISO date, boolean, URL, option id, option ids, user id. */
export const propertyKinds = ["text", "number", "date", "boolean", "url", "dropdown", "multi_select", "person"] as const;
export type PropertyKind = (typeof propertyKinds)[number];
/** Kinds whose values are chosen from the property's options. */
export const optionKinds: ReadonlyArray<PropertyKind> = ["dropdown", "multi_select"];
export const maxPropertyOptions = 50;
export const maxTextValueLength = 2000;

/** The icons a Work item type can show; the UI draws each one. */
export const typeIcons = ["task", "bug", "request", "approval", "document", "group"] as const;
export type TypeIcon = (typeof typeIcons)[number];
export const maxTypesPerProject = 30;

/**
 * Plain suggestions an admin can add in one click. Each has a one-line explanation in plain words. Developer words such as Epic are not
 * suggested: an admin who wants one types it in. "Big task" is not a Module (a Module groups work by topic, see GLOSSARY.md).
 */
export const typeSuggestions: ReadonlyArray<{ key: string; name: string; icon: TypeIcon; color: string; description: string }> = [
  { key: "bug", name: "Bug", icon: "bug", color: "#dc2626", description: "Something that works wrongly and needs fixing." },
  { key: "request", name: "Request", icon: "request", color: "#2563eb", description: "Someone asks for something new or for a change." },
  { key: "approval", name: "Approval", icon: "approval", color: "#16a34a", description: "Needs a yes or no from a named person before work goes on." },
  { key: "document", name: "Document", icon: "document", color: "#9333ea", description: "A text to write or review, such as a plan, a policy or a report." },
  { key: "big-task", name: "Big task", icon: "group", color: "#ea580c", description: "A large piece of work that groups smaller tasks under it." },
];

export interface PropertyOption { id: string; label: string; position: number }
export interface PropertyDef {
  id: string; projectId: string; name: string; kind: PropertyKind; required: boolean; defaultValue: unknown; position: number;
  options: PropertyOption[]; typeIds: string[];
}

export const hasValue = (value: unknown) => value !== null && value !== undefined && value !== "" && !(Array.isArray(value) && value.length === 0);

/**
 * Turns one value the caller sent into the stored JSON for a property, or null to clear it. Throws a 400 that names the property.
 * Option kinds accept an option id or its label (case-insensitive), so an Agent can send the word it reads.
 */
export function coerceValue(property: PropertyDef, raw: unknown, memberIds: ReadonlySet<string>): unknown {
  if (raw === null || raw === undefined) return null;
  const fail = (reason: string): never => { throw new ActionError(`${property.name}: ${reason}`, 400); };
  const optionId = (entry: unknown) => {
    if (typeof entry !== "string") return fail("must be one of the property's options");
    const wanted = entry.trim().toLowerCase();
    const found = property.options.find((option) => option.id === entry.trim() || option.label.toLowerCase() === wanted);
    if (!found) return fail(`"${entry}" is not one of the options: ${property.options.map((option) => option.label).join(", ") || "none yet"}`);
    return found.id;
  };
  switch (property.kind) {
    case "text": {
      if (typeof raw !== "string") return fail("must be text");
      const value = raw.trim();
      if (value.length > maxTextValueLength) return fail(`must be at most ${maxTextValueLength} characters`);
      return value === "" ? null : value;
    }
    case "number": {
      const value = typeof raw === "number" ? raw : typeof raw === "string" && /^-?\d+(\.\d+)?$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
      if (!Number.isFinite(value) || Math.abs(value) > 1e12) return fail("must be a number");
      return value;
    }
    case "date": {
      const text = typeof raw === "string" ? raw.trim() : "";
      const parsed = new Date(`${text}T00:00:00Z`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) return fail("must be a date as YYYY-MM-DD");
      return text;
    }
    case "boolean": {
      if (raw === true || raw === "true") return true;
      if (raw === false || raw === "false") return false;
      return fail("must be yes or no");
    }
    case "url": {
      if (typeof raw !== "string") return fail("must be a web address");
      const value = raw.trim();
      if (value === "") return null;
      if (value.length > maxTextValueLength) return fail(`must be at most ${maxTextValueLength} characters`);
      let parsed: URL | null = null;
      try { parsed = new URL(value); } catch { parsed = null; }
      if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) return fail("must be a web address starting with http:// or https://");
      return value;
    }
    case "dropdown": {
      const value = raw === "" ? null : optionId(raw);
      return value;
    }
    case "multi_select": {
      if (!Array.isArray(raw)) return fail("must be a list of options");
      const ids = raw.map(optionId);
      if (new Set(ids).size !== ids.length) return fail("lists the same option twice");
      return ids.length === 0 ? null : ids;
    }
    case "person": {
      if (raw === "") return null;
      if (typeof raw !== "string" || !memberIds.has(raw)) return fail("must be a member of this project");
      return raw;
    }
  }
}

/** The properties of a project with their options and types, in the order people see them. */
export async function loadProperties(database: Database, projectId: string, typeId?: string): Promise<PropertyDef[]> {
  const rows = typeId
    ? await database.select({ property: customProperties }).from(customProperties)
      .innerJoin(customPropertyTypes, eq(customPropertyTypes.propertyId, customProperties.id))
      .where(and(eq(customProperties.projectId, projectId), eq(customPropertyTypes.typeId, typeId))).orderBy(asc(customProperties.position), asc(customProperties.name))
    : await database.select().from(customProperties).where(eq(customProperties.projectId, projectId)).orderBy(asc(customProperties.position), asc(customProperties.name));
  if (rows.length === 0) return [];
  const ids = rows.map((row) => ("property" in row ? row.property.id : row.id));
  const properties = rows.map((row) => ("property" in row ? row.property : row));
  const options = await database.select().from(customPropertyOptions).where(inArray(customPropertyOptions.propertyId, ids)).orderBy(asc(customPropertyOptions.position));
  const links = await database.select().from(customPropertyTypes).where(inArray(customPropertyTypes.propertyId, ids));
  return properties.map((property) => ({
    id: property.id, projectId: property.projectId, name: property.name, kind: property.kind as PropertyKind, required: property.required,
    defaultValue: property.defaultValue ?? null, position: property.position,
    options: options.filter((option) => option.propertyId === property.id).map((option) => ({ id: option.id, label: option.label, position: option.position })),
    typeIds: links.filter((link) => link.propertyId === property.id).map((link) => link.typeId),
  }));
}

/** The property values of several work items: propertyId and value, sorted by property id. */
export async function loadPropertyValues(database: Database, workItemIds: string[]) {
  const result = new Map<string, Array<{ propertyId: string; value: unknown }>>(workItemIds.map((id) => [id, []]));
  if (workItemIds.length === 0) return result;
  const rows = await database.select().from(workItemPropertyValues).where(inArray(workItemPropertyValues.workItemId, workItemIds));
  for (const row of rows) result.get(row.workItemId)?.push({ propertyId: row.propertyId, value: row.value });
  for (const values of result.values()) values.sort((a, b) => a.propertyId.localeCompare(b.propertyId));
  return result;
}

/** Throws the 400 a required property raises: names every one of the type's required properties still without a value. */
export function assertRequiredFilled(type: { name: string }, properties: PropertyDef[], values: Map<string, unknown>) {
  const missing = properties.filter((property) => property.required && !hasValue(values.get(property.id)));
  if (missing.length > 0) {
    throw new ActionError(`${missing.map((property) => `"${property.name}"`).join(", ")} ${missing.length === 1 ? "is" : "are"} required for ${type.name}. Fill ${missing.length === 1 ? "it" : "them"} before saving.`, 400);
  }
}

export async function loadTypeRow(database: Database, projectId: string, typeId: string) {
  const [type] = await database.select().from(workItemTypes).where(and(eq(workItemTypes.id, typeId), eq(workItemTypes.projectId, projectId)));
  if (!type) throw new ActionError("Work item type not found in this project", 400);
  return type;
}

/** The type every new work item gets when none is named: the first type of the project (Task on a new project). Creates Task when a project has none. */
export async function defaultTypeOf(database: Database, project: { id: string; workspaceId: string }) {
  const [existing] = await database.select().from(workItemTypes).where(eq(workItemTypes.projectId, project.id)).orderBy(asc(workItemTypes.position), asc(workItemTypes.name)).limit(1);
  if (existing) return existing;
  const [created] = await database.insert(workItemTypes).values({ workspaceId: project.workspaceId, projectId: project.id, name: "Task", icon: "task", color: "#6b7280", description: "The default type for every work item", position: 0 })
    .onConflictDoNothing().returning();
  if (created) return created;
  const [again] = await database.select().from(workItemTypes).where(eq(workItemTypes.projectId, project.id)).orderBy(asc(workItemTypes.position)).limit(1);
  return again!;
}

/**
 * Gives a work item that a path other than create_work_item just inserted (Intake) its starting values: the project's
 * default type and, while types are on, the default value of each property of that type. Returns the type id to store.
 */
export async function startingType(database: Database, project: { id: string; workspaceId: string }) {
  return (await defaultTypeOf(database, project)).id;
}

/** Writes the default values of the item's type's properties; call after the item row exists. Does nothing while types are off. */
export async function applyPropertyDefaults(database: Database, project: { id: string; typesEnabled: boolean }, item: { id: string; typeId: string | null }) {
  if (!project.typesEnabled || !item.typeId) return;
  const properties = await loadProperties(database, project.id, item.typeId);
  for (const property of properties) {
    if (property.defaultValue === null || property.defaultValue === undefined || !hasValue(property.defaultValue)) continue;
    await database.insert(workItemPropertyValues).values({ workItemId: item.id, propertyId: property.id, value: property.defaultValue })
      .onConflictDoNothing();
  }
}

/**
 * The activity field of a custom property change. It carries the property id, so the timeline can show the property's
 * current name after a rename, and the name at the time, so it still reads after the property is deleted.
 */
export const propertyActivityField = (propertyId: string, name: string) => `property:${propertyId}:${name}`;

const propertyFieldPattern = /^property:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(.*)$/s;

/** Reads a stored activity field: a property change gives its id (null for rows written before ids were kept) and the name it was logged with. */
export function parsePropertyActivityField(field: string): { propertyId: string | null; name: string } | null {
  if (!field.startsWith("property:")) return null;
  const match = propertyFieldPattern.exec(field);
  return match ? { propertyId: match[1]!, name: match[2]! } : { propertyId: null, name: field.slice("property:".length) };
}

/** The field receivers and the timeline see: property:<name>, never the id. Other fields pass through. */
export function publicActivityField(field: string, currentName?: string) {
  const parsed = parsePropertyActivityField(field);
  return parsed ? `property:${currentName ?? parsed.name}` : field;
}
