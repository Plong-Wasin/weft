import React from "react";
import { BadgeCheck, Bug, CheckSquare, FileText, Inbox, Layers } from "lucide-react";
import { translate, type MessageKey } from "@weft/shared";
import { action } from "./api";
import { SingleSelect } from "./property-dropdowns";
import type { Member, Project } from "./types";

const t = (key: string) => translate(key as MessageKey);

export const typeIcons = ["task", "bug", "request", "approval", "document", "group"] as const;
export type TypeIcon = (typeof typeIcons)[number];
export const propertyKinds = ["text", "number", "date", "boolean", "url", "dropdown", "multi_select", "person"] as const;
export type PropertyKind = (typeof propertyKinds)[number];
export const optionKinds: ReadonlyArray<PropertyKind> = ["dropdown", "multi_select"];

export type WorkItemType = { id: string; projectId: string; name: string; icon: TypeIcon; color: string; description: string; position: number; workItems: number };
export type PropertyOption = { id: string; label: string; position: number };
export type CustomProperty = { id: string; projectId: string; name: string; kind: PropertyKind; required: boolean; defaultValue: unknown; position: number; options: PropertyOption[]; typeIds: string[] };
export type PropertyValue = { propertyId: string; value: unknown };
export type Suggestion = { key: string; name: string; icon: TypeIcon; color: string; description: string };

const iconComponents = { task: CheckSquare, bug: Bug, request: Inbox, approval: BadgeCheck, document: FileText, group: Layers } as const;

/** The small icon of a type, drawn in the type's colour. */
export function TypeIconMark({ icon, color, size = 14 }: { icon: string; color: string; size?: number }) {
  const Icon = iconComponents[icon as TypeIcon] ?? CheckSquare;
  return <Icon aria-hidden size={size} style={{ color }} />;
}

/** Loads the types and custom properties of a project; `ready` is false until the first answer. */
export function useWorkItemTypes(project: Pick<Project, "id" | "features">) {
  const [types, setTypes] = React.useState<WorkItemType[]>([]);
  const [properties, setProperties] = React.useState<CustomProperty[]>([]);
  const [ready, setReady] = React.useState(false);
  const reload = React.useCallback(async () => {
    const [typeRows, propertyRows] = await Promise.all([
      action<WorkItemType[]>("list_work_item_types", { projectId: project.id }),
      action<CustomProperty[]>("list_custom_properties", { projectId: project.id }),
    ]);
    setTypes(typeRows ?? []);
    setProperties(propertyRows ?? []);
    setReady(true);
  }, [project.id]);
  React.useEffect(() => { void reload(); }, [reload]);
  return { types, properties, ready, reload };
}

/** Picks the type of a work item. Read-only shows the name and icon alone. */
export function TypePicker({ types, value, onSelect, readOnly, iconOnly }: { types: WorkItemType[]; value: string; onSelect: (id: string) => void; readOnly?: boolean; iconOnly?: boolean }) {
  const current = types.find((type) => type.id === value) ?? types[0];
  if (!current) return null;
  return <SingleSelect label={t("types.type")} readOnly={readOnly} iconOnly={iconOnly} value={current.id}
    icon={<TypeIconMark icon={current.icon} color={current.color} />} summary={current.name}
    options={types.map((type) => ({ id: type.id, name: type.name, icon: <TypeIconMark icon={type.icon} color={type.color} /> }))} onSelect={onSelect} />;
}

/** The properties that a type shows: the ones it belongs to, in order. */
export function propertiesOfType(properties: CustomProperty[], typeId: string) {
  return properties.filter((property) => property.typeIds.includes(typeId));
}

/** Names of the properties of the current type that have a value now but would be dropped by moving to `nextTypeId`. */
export function droppedByTypeChange(properties: CustomProperty[], values: PropertyValue[], nextTypeId: string) {
  const kept = new Set(propertiesOfType(properties, nextTypeId).map((property) => property.id));
  return values.filter((entry) => !kept.has(entry.propertyId) && hasValue(entry.value)).map((entry) => properties.find((property) => property.id === entry.propertyId)?.name ?? "");
}

export const hasValue = (value: unknown) => value !== null && value !== undefined && value !== "" && !(Array.isArray(value) && value.length === 0);

/** Properties of the type that are required and still empty, by name. */
export function missingRequired(properties: CustomProperty[], values: Map<string, unknown>) {
  return properties.filter((property) => property.required && !hasValue(values.get(property.id))).map((property) => property.name);
}

/** The text a value shows as in an input: options by label, yes or no, the date or number as typed. */
function inputValue(value: unknown) {
  if (value === null || value === undefined) return "";
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

const fieldClass = "grid gap-1 text-13";

/**
 * One input per property of a type. A value is the JSON the server stores; null clears it. A required property says so in its label.
 * Dropdown and multi-select options are the ids the server returns, with their labels shown.
 */
export function PropertyFields({ properties, values, members, onChange, disabled, idPrefix, commitOnBlur }: {
  properties: CustomProperty[]; values: Map<string, unknown>; members: Member[]; onChange: (property: CustomProperty, value: unknown) => void; disabled?: boolean; idPrefix: string;
  /** Text-like inputs save when the person leaves them (or presses Enter), not on every key. */
  commitOnBlur?: boolean;
}) {
  if (properties.length === 0) return null;
  return <div className="grid gap-3" data-property-fields>
    {properties.map((property) => {
      const id = `${idPrefix}-${property.id}`;
      const value = values.get(property.id);
      const label = <span className="flex items-center gap-2 font-medium text-primary">{property.name}{property.required && <span className="rounded bg-layer-1 px-1.5 py-0.5 text-11 font-medium text-secondary" data-required-marker>{t("types.required")}</span>}</span>;
      const hint = <span className="text-12 text-tertiary">{t(`types.kindHint.${property.kind}`)}</span>;
      if (property.kind === "boolean") {
        return <label key={property.id} htmlFor={id} className="flex items-center gap-2 text-13">
          <input id={id} type="checkbox" role="switch" disabled={disabled} checked={value === true} onChange={(event) => onChange(property, event.target.checked ? true : null)} />
          <span className="font-medium text-primary">{property.name}</span>{property.required && <span className="rounded bg-layer-1 px-1.5 py-0.5 text-11 font-medium text-secondary" data-required-marker>{t("types.required")}</span>}
        </label>;
      }
      if (property.kind === "multi_select") {
        const selected = Array.isArray(value) ? value as string[] : [];
        return <fieldset key={property.id} className={fieldClass} data-property={property.id}>
          <legend className="mb-1">{label}</legend>
          <div className="flex flex-wrap gap-2">{property.options.map((option) => <label key={option.id} className="flex items-center gap-1.5 rounded-md border border-subtle px-2 py-1 text-13">
            <input type="checkbox" disabled={disabled} checked={selected.includes(option.id)} onChange={(event) => {
              const next = event.target.checked ? [...selected, option.id] : selected.filter((id) => id !== option.id);
              onChange(property, next.length ? next : null);
            }} />{option.label}
          </label>)}</div>
          {hint}
        </fieldset>;
      }
      if (property.kind === "dropdown" || property.kind === "person") {
        const options = property.kind === "dropdown" ? property.options.map((option) => ({ id: option.id, label: option.label })) : members.map((member) => ({ id: member.userId, label: member.name }));
        return <label key={property.id} htmlFor={id} className={fieldClass} data-property={property.id}>{label}
          <select id={id} disabled={disabled} value={typeof value === "string" ? value : ""} onChange={(event) => onChange(property, event.target.value || null)}>
            <option value="">{t("types.noValue")}</option>
            {options.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
          </select>{hint}
        </label>;
      }
      const inputType = property.kind === "number" ? "number" : property.kind === "date" ? "date" : property.kind === "url" ? "url" : "text";
      const convert = (text: string) => text === "" ? null : property.kind === "number" ? Number(text) : text;
      if (commitOnBlur && property.kind !== "date") {
        return <label key={property.id} htmlFor={id} className={fieldClass} data-property={property.id}>{label}
          <DraftInput id={id} type={inputType} disabled={disabled} value={inputValue(value)} maxLength={property.kind === "text" ? 2000 : undefined} onCommit={(text) => onChange(property, convert(text))} />
          {hint}
        </label>;
      }
      return <label key={property.id} htmlFor={id} className={fieldClass} data-property={property.id}>{label}
        <input id={id} type={inputType} disabled={disabled} value={inputValue(value)} maxLength={property.kind === "text" ? 2000 : undefined}
          onChange={(event) => onChange(property, convert(event.target.value))} />
        {hint}
      </label>;
    })}
  </div>;
}

/** A text-like input that keeps what is typed until it loses focus or Enter is pressed, then commits it once. */
function DraftInput({ id, type, value, disabled, maxLength, onCommit }: { id: string; type: string; value: string; disabled?: boolean; maxLength?: number; onCommit: (text: string) => void }) {
  const [draft, setDraft] = React.useState(value);
  React.useEffect(() => setDraft(value), [value]);
  const commit = () => { if (draft !== value) onCommit(draft); };
  return <input id={id} type={type} disabled={disabled} value={draft} maxLength={maxLength} onChange={(event) => setDraft(event.target.value)}
    onBlur={commit} onKeyDown={(event) => { if (event.key === "Enter" && type !== "number") { event.preventDefault(); commit(); } }} />;
}

/** Plain suggestions for the settings page; the server lists them too, so the page never hard-codes a second copy. */
export async function loadSuggestions(projectId: string) {
  return (await action<Suggestion[]>("list_work_item_type_suggestions", { projectId })) ?? [];
}
