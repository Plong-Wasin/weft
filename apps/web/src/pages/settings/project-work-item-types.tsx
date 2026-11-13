import React from "react";
import { translate, type MessageKey } from "@weft/shared";
import { actionResult } from "../../api";
import { Note, RowList, Row, SettingsBlock } from "./settings-ui";
import { TypeIconMark, loadSuggestions, optionKinds, propertyKinds, typeIcons, useWorkItemTypes, type CustomProperty, type PropertyKind, type Suggestion, type TypeIcon, type WorkItemType } from "../../work-item-types";
import type { Project } from "../../types";

const t = (key: string) => translate(key as MessageKey);
const replaceAll = (text: string, values: Record<string, string>) => Object.entries(values).reduce((result, [key, value]) => result.replace(`{${key}}`, value), text);

/** The plain line that says how a type differs from a label. */
export const typeVersusLabel = () => t("types.explain");

/**
 * Project settings for Work item types: the types (add, rename, recolour, describe, delete, with a move when in use), the one-click
 * suggestions, and the custom properties with their kinds, options, required flag and the types they belong to.
 */
export function WorkItemTypesSettings({ project }: { project: Project }) {
  const { types, properties, ready, reload } = useWorkItemTypes(project);
  const [suggestions, setSuggestions] = React.useState<Suggestion[]>([]);
  const [note, setNote] = React.useState<string | null>(null);
  const [error, setError] = React.useState(false);
  React.useEffect(() => { void loadSuggestions(project.id).then(setSuggestions); }, [project.id]);
  const run = async (name: string, body: Record<string, unknown>, failedKey: MessageKey) => {
    const result = await actionResult(name, { projectId: project.id, ...body });
    if ("error" in result) { setError(true); setNote(result.error || t(failedKey)); return false; }
    setError(false); setNote(null); await reload();
    return true;
  };
  const existingNames = new Set(types.map((type) => type.name.toLowerCase()));
  const available = suggestions.filter((suggestion) => !existingNames.has(suggestion.name.toLowerCase()));
  return <SettingsBlock title={t("types.title")} description={typeVersusLabel()}>
    {!ready ? <p className="m-0 text-13 text-secondary">{t("types.loading")}</p> : <>
      <RowList>{types.map((type) => <TypeRow key={type.id} type={type} types={types} onRun={run} />)}</RowList>
      <AddType onAdd={(body) => run("create_work_item_type", body, "types.failed")} />
      {available.length > 0 && <div className="grid gap-2" data-suggestions>
        <h3 className="m-0 text-14 font-semibold text-primary">{t("types.suggestions")}</h3>
        <p className="m-0 text-13 text-secondary">{t("types.suggestionsHint")}</p>
        <RowList>{available.map((suggestion) => <Row key={suggestion.key}>
          <span className="flex flex-1 items-start gap-2">
            <span className="mt-0.5"><TypeIconMark icon={suggestion.icon} color={suggestion.color} /></span>
            <span className="grid gap-0.5"><span className="font-medium">{suggestion.name}</span><span className="text-13 text-secondary">{suggestion.description}</span></span>
          </span>
          <button type="button" className="secondary" onClick={() => void run("create_work_item_type", { name: suggestion.name, icon: suggestion.icon, color: suggestion.color, description: suggestion.description }, "types.failed")}>
            {replaceAll(t("types.addSuggestion"), { name: suggestion.name })}
          </button>
        </Row>)}</RowList>
      </div>}
      <PropertiesBlock types={types} properties={properties} onRun={run} />
      {note && <Note note={note} error={error} />}
    </>}
  </SettingsBlock>;
}

function TypeRow({ type, types, onRun }: { type: WorkItemType; types: WorkItemType[]; onRun: (name: string, body: Record<string, unknown>, failedKey: MessageKey) => Promise<boolean> }) {
  const [editing, setEditing] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const [name, setName] = React.useState(type.name);
  const [icon, setIcon] = React.useState<TypeIcon>(type.icon);
  const [color, setColor] = React.useState(type.color);
  const [description, setDescription] = React.useState(type.description);
  const [moveTo, setMoveTo] = React.useState("");
  const [dropValues, setDropValues] = React.useState(false);
  const others = types.filter((other) => other.id !== type.id);
  return <Row>
    <span className="flex min-w-0 flex-1 items-start gap-2">
      <span className="mt-0.5"><TypeIconMark icon={type.icon} color={type.color} /></span>
      <span className="grid min-w-0 gap-0.5">
        <span className="font-medium">{type.name}</span>
        {type.description && <span className="text-13 text-secondary">{type.description}</span>}
        <span className="text-12 text-tertiary">{type.workItems === 1 ? replaceAll(t("types.countOne"), { count: "1" }) : replaceAll(t("types.count"), { count: String(type.workItems) })}</span>
        {editing && <span className="mt-2 grid gap-2 rounded-md border border-subtle bg-layer-1 p-3" data-type-editor>
          <label className="grid gap-1 text-13">{t("types.name")}<input value={name} maxLength={40} onChange={(event) => setName(event.target.value)} /></label>
          <label className="grid gap-1 text-13">{t("types.icon")}<select value={icon} onChange={(event) => setIcon(event.target.value as TypeIcon)}>{typeIcons.map((value) => <option key={value} value={value}>{t(`types.icon.${value}`)}</option>)}</select></label>
          <label className="grid gap-1 text-13">{t("types.color")}<input type="color" value={color} onChange={(event) => setColor(event.target.value)} /></label>
          <label className="grid gap-1 text-13">{t("types.description")}<input value={description} maxLength={200} onChange={(event) => setDescription(event.target.value)} /></label>
          <span className="flex flex-wrap gap-2">
            <button type="button" onClick={() => void onRun("update_work_item_type", { typeId: type.id, name, icon, color, description }, "types.failed").then((ok) => ok && setEditing(false))}>{t("types.save")}</button>
            <button type="button" className="secondary" onClick={() => setEditing(false)}>{t("types.cancel")}</button>
          </span>
        </span>}
        {deleting && <span className="mt-2 grid gap-2 rounded-md border border-subtle bg-layer-1 p-3" role="group" aria-label={replaceAll(t("types.deleteHeading"), { name: type.name })} data-type-delete>
          <span className="font-medium">{replaceAll(t("types.deleteHeading"), { name: type.name })}</span>
          {type.workItems > 0 ? <>
            <span className="text-13 text-secondary">{replaceAll(t("types.deleteInUse"), { count: String(type.workItems) })}</span>
            <label className="grid gap-1 text-13">{t("types.moveTo")}<select value={moveTo} onChange={(event) => setMoveTo(event.target.value)}>
              <option value="">{t("types.choose")}</option>
              {others.map((other) => <option key={other.id} value={other.id}>{other.name}</option>)}
            </select></label>
            <label className="flex items-center gap-2 text-13"><input type="checkbox" checked={dropValues} onChange={(event) => setDropValues(event.target.checked)} />{t("types.dropValuesOnMove")}</label>
          </> : <span className="text-13 text-secondary">{t("types.deleteUnused")}</span>}
          <span className="flex flex-wrap gap-2">
            <button type="button" disabled={type.workItems > 0 && !moveTo} onClick={() => void onRun("delete_work_item_type", { typeId: type.id, ...(moveTo ? { moveToTypeId: moveTo } : {}), ...(dropValues ? { dropPropertyValues: true } : {}) }, "types.failed").then((ok) => ok && setDeleting(false))}>{t("types.confirmDelete")}</button>
            <button type="button" className="secondary" onClick={() => setDeleting(false)}>{t("types.cancel")}</button>
          </span>
        </span>}
      </span>
    </span>
    <span className="flex flex-wrap items-center gap-2">
      <button type="button" className="secondary" aria-label={replaceAll(t("types.editNamed"), { name: type.name })} onClick={() => { setEditing((value) => !value); setDeleting(false); }}>{t("types.edit")}</button>
      <button type="button" className="secondary" aria-label={replaceAll(t("types.deleteNamed"), { name: type.name })} disabled={types.length <= 1} onClick={() => { setDeleting((value) => !value); setEditing(false); }}>{t("types.delete")}</button>
    </span>
  </Row>;
}

function AddType({ onAdd }: { onAdd: (body: Record<string, unknown>) => Promise<boolean> }) {
  const [name, setName] = React.useState("");
  const [icon, setIcon] = React.useState<TypeIcon>("task");
  const [color, setColor] = React.useState("#6b7280");
  const [description, setDescription] = React.useState("");
  return <form className="grid gap-3 rounded-md border border-subtle p-3" onSubmit={async (event) => {
    event.preventDefault();
    if (!name.trim()) return;
    if (await onAdd({ name: name.trim(), icon, color, description: description.trim() })) { setName(""); setDescription(""); }
  }}>
    <h3 className="m-0 text-14 font-semibold text-primary">{t("types.add")}</h3>
    <div className="flex flex-wrap items-end gap-3">
      <label className="grid gap-1 text-13">{t("types.name")}<input required value={name} maxLength={40} onChange={(event) => setName(event.target.value)} /></label>
      <label className="grid gap-1 text-13">{t("types.icon")}<select value={icon} onChange={(event) => setIcon(event.target.value as TypeIcon)}>{typeIcons.map((value) => <option key={value} value={value}>{t(`types.icon.${value}`)}</option>)}</select></label>
      <label className="grid gap-1 text-13">{t("types.color")}<input type="color" value={color} onChange={(event) => setColor(event.target.value)} /></label>
      <label className="grid min-w-48 flex-1 gap-1 text-13">{t("types.description")}<input value={description} maxLength={200} placeholder={t("types.descriptionHint")} onChange={(event) => setDescription(event.target.value)} /></label>
      <button type="submit">{t("types.add")}</button>
    </div>
  </form>;
}

function PropertiesBlock({ types, properties, onRun }: { types: WorkItemType[]; properties: CustomProperty[]; onRun: (name: string, body: Record<string, unknown>, failedKey: MessageKey) => Promise<boolean> }) {
  const typeName = (id: string) => types.find((type) => type.id === id)?.name ?? "";
  return <div className="grid gap-3" data-properties>
    <h3 className="m-0 text-14 font-semibold text-primary">{t("types.properties")}</h3>
    <p className="m-0 text-13 text-secondary">{t("types.propertiesExplain")}</p>
    {properties.length === 0 && <p className="m-0 text-13 text-secondary">{t("types.noProperties")}</p>}
    <RowList>{properties.map((property) => <PropertyRow key={property.id} property={property} types={types} typeName={typeName} onRun={onRun} />)}</RowList>
    <AddProperty types={types} onAdd={(body) => onRun("create_custom_property", body, "types.failed")} />
  </div>;
}

function PropertyRow({ property, types, typeName, onRun }: { property: CustomProperty; types: WorkItemType[]; typeName: (id: string) => string; onRun: (name: string, body: Record<string, unknown>, failedKey: MessageKey) => Promise<boolean> }) {
  const [editing, setEditing] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const [name, setName] = React.useState(property.name);
  const [required, setRequired] = React.useState(property.required);
  const [options, setOptions] = React.useState(property.options.map((option) => option.label).join("\n"));
  const [typeIds, setTypeIds] = React.useState<string[]>(property.typeIds);
  const isOption = optionKinds.includes(property.kind);
  const save = async () => {
    const lines = options.split("\n").map((line) => line.trim()).filter(Boolean);
    const body: Record<string, unknown> = { propertyId: property.id, name: name.trim(), required, typeIds };
    if (isOption) {
      // A label that matches an existing option keeps its id, so values on work items stay where they are.
      body.options = lines.map((label) => {
        const existing = property.options.find((option) => option.label.toLowerCase() === label.toLowerCase());
        return existing ? { id: existing.id, label } : { label };
      });
    }
    if (await onRun("update_custom_property", body, "types.failed")) setEditing(false);
  };
  return <Row>
    <span className="grid min-w-0 flex-1 gap-0.5">
      <span className="flex flex-wrap items-center gap-2"><span className="font-medium">{property.name}</span>
        <span className="rounded bg-layer-1 px-1.5 py-0.5 text-11 text-secondary">{t(`types.kind.${property.kind}`)}</span>
        {property.required && <span className="rounded bg-layer-1 px-1.5 py-0.5 text-11 font-medium text-secondary">{t("types.required")}</span>}</span>
      <span className="text-12 text-tertiary">{replaceAll(t("types.usedBy"), { types: property.typeIds.map(typeName).filter(Boolean).join(", ") || t("types.none") })}</span>
      {isOption && property.options.length > 0 && <span className="text-12 text-tertiary">{replaceAll(t("types.optionsList"), { options: property.options.map((option) => option.label).join(", ") })}</span>}
      {editing && <span className="mt-2 grid gap-2 rounded-md border border-subtle bg-layer-1 p-3" data-property-editor>
        <label className="grid gap-1 text-13">{t("types.propertyName")}<input value={name} maxLength={60} onChange={(event) => setName(event.target.value)} /></label>
        {isOption && <label className="grid gap-1 text-13">{t("types.optionsOnePerLine")}<textarea rows={4} value={options} onChange={(event) => setOptions(event.target.value)} /></label>}
        <label className="flex items-center gap-2 text-13"><input type="checkbox" checked={required} onChange={(event) => setRequired(event.target.checked)} />{t("types.requiredToggle")}</label>
        <fieldset className="grid gap-1 text-13"><legend className="mb-1">{t("types.belongsTo")}</legend>
          {types.map((type) => <label key={type.id} className="flex items-center gap-2"><input type="checkbox" checked={typeIds.includes(type.id)} onChange={(event) => setTypeIds(event.target.checked ? [...typeIds, type.id] : typeIds.filter((id) => id !== type.id))} />{type.name}</label>)}
        </fieldset>
        <span className="flex flex-wrap gap-2">
          <button type="button" disabled={typeIds.length === 0} onClick={() => void save()}>{t("types.save")}</button>
          <button type="button" className="secondary" onClick={() => setEditing(false)}>{t("types.cancel")}</button>
        </span>
      </span>}
      {deleting && <span className="mt-2 grid gap-2 rounded-md border border-subtle bg-layer-1 p-3" role="group" aria-label={replaceAll(t("types.deletePropertyHeading"), { name: property.name })} data-property-delete>
        <span className="font-medium">{replaceAll(t("types.deletePropertyHeading"), { name: property.name })}</span>
        <span className="text-13 text-secondary">{t("types.deletePropertyBody")}</span>
        <span className="flex flex-wrap gap-2">
          <button type="button" onClick={() => void onRun("delete_custom_property", { propertyId: property.id }, "types.failed").then((ok) => ok && setDeleting(false))}>{t("types.confirmDelete")}</button>
          <button type="button" className="secondary" onClick={() => setDeleting(false)}>{t("types.cancel")}</button>
        </span>
      </span>}
    </span>
    <span className="flex flex-wrap items-center gap-2">
      <button type="button" className="secondary" aria-label={replaceAll(t("types.editNamed"), { name: property.name })} onClick={() => { setEditing((value) => !value); setDeleting(false); }}>{t("types.edit")}</button>
      <button type="button" className="secondary" aria-label={replaceAll(t("types.deleteNamed"), { name: property.name })} onClick={() => { setDeleting((value) => !value); setEditing(false); }}>{t("types.delete")}</button>
    </span>
  </Row>;
}

function AddProperty({ types, onAdd }: { types: WorkItemType[]; onAdd: (body: Record<string, unknown>) => Promise<boolean> }) {
  const [name, setName] = React.useState("");
  const [kind, setKind] = React.useState<PropertyKind>("text");
  const [options, setOptions] = React.useState("");
  const [required, setRequired] = React.useState(false);
  const [typeIds, setTypeIds] = React.useState<string[]>(types[0] ? [types[0].id] : []);
  const isOption = optionKinds.includes(kind);
  const ready = name.trim() !== "" && typeIds.length > 0 && (!isOption || options.trim() !== "");
  return <form className="grid gap-3 rounded-md border border-subtle p-3" data-add-property onSubmit={async (event) => {
    event.preventDefault();
    if (!ready) return;
    const lines = options.split("\n").map((line) => line.trim()).filter(Boolean);
    const ok = await onAdd({ name: name.trim(), kind, required, typeIds, ...(isOption ? { options: lines } : {}) });
    if (ok) { setName(""); setOptions(""); setRequired(false); }
  }}>
    <h3 className="m-0 text-14 font-semibold text-primary">{t("types.addProperty")}</h3>
    <div className="flex flex-wrap items-end gap-3">
      <label className="grid gap-1 text-13">{t("types.propertyName")}<input required value={name} maxLength={60} onChange={(event) => setName(event.target.value)} /></label>
      <label className="grid gap-1 text-13">{t("types.propertyKind")}<select value={kind} onChange={(event) => setKind(event.target.value as PropertyKind)}>
        {propertyKinds.map((value) => <option key={value} value={value}>{t(`types.kind.${value}`)}</option>)}
      </select></label>
      {isOption && <label className="grid min-w-48 flex-1 gap-1 text-13">{t("types.optionsOnePerLine")}<textarea rows={3} value={options} onChange={(event) => setOptions(event.target.value)} /></label>}
    </div>
    <div className="flex flex-wrap gap-4">
      <label className="flex items-center gap-2 text-13"><input type="checkbox" checked={required} onChange={(event) => setRequired(event.target.checked)} />{t("types.requiredToggle")}</label>
      <fieldset className="flex flex-wrap items-center gap-3 text-13"><legend className="mr-2">{t("types.belongsTo")}</legend>
        {types.map((type) => <label key={type.id} className="flex items-center gap-1.5"><input type="checkbox" checked={typeIds.includes(type.id)} onChange={(event) => setTypeIds(event.target.checked ? [...typeIds, type.id] : typeIds.filter((id) => id !== type.id))} />{type.name}</label>)}
      </fieldset>
    </div>
    <div><button type="submit" disabled={!ready}>{t("types.addProperty")}</button></div>
  </form>;
}
