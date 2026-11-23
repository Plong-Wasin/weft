import React from "react";
import { translate, type MessageKey } from "@weft/shared";
import { actionResult } from "../../api";
import { Note, RowList, Row, SettingsBlock } from "./settings-ui";
import { SortableList, SortMenu } from "../../sortable-list";
import { TypeIconMark, loadSuggestions, optionKinds, propertiesOfType, propertyKinds, useWorkItemTypes, type CustomProperty, type PropertyKind, type Suggestion, type WorkItemType } from "../../work-item-types";
import type { Project } from "../../types";
import { TypeForm, type TypeValues } from "./type-form";
import { typeDescriptionText } from "../../type-descriptions";

const t = (key: string) => translate(key as MessageKey);
// Every occurrence: a line may name the same property or type twice.
const replaceAll = (text: string, values: Record<string, string>) => Object.entries(values).reduce((result, [key, value]) => result.split(`{${key}}`).join(value), text);

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
  // Role null means a workspace Admin who is no project member; the server decides.
  const canReorder = project.role === "Admin" || project.role === null;
  const moveType = (index: number, delta: -1 | 1) => {
    const ids = types.map((type) => type.id);
    [ids[index], ids[index + delta]] = [ids[index + delta]!, ids[index]!];
    void run("reorder_work_item_types", { typeIds: ids }, "types.failed");
  };
  const available = suggestions.filter((suggestion) => !existingNames.has(suggestion.name.toLowerCase()));
  return <SettingsBlock title={t("types.title")} description={typeVersusLabel()}>
    {!ready ? <p className="m-0 text-13 text-secondary">{t("types.loading")}</p> : <>
      <SortableList ids={types.map((type) => type.id)} disabled={!canReorder} label={(id) => types.find((type) => type.id === id)?.name ?? ""}
        onReorder={(ids) => void run("reorder_work_item_types", { typeIds: ids }, "types.failed")}
        renderRow={(id, grip) => {
          const index = types.findIndex((type) => type.id === id);
          return <TypeRow type={types[index]!} types={types} properties={properties} onRun={run} grip={canReorder ? grip : null}
            canUp={index > 0} canDown={index < types.length - 1} onMove={(delta) => moveType(index, delta)} />;
        }} />
      <AddType onAdd={(body) => run("create_work_item_type", body, "types.failed")} />
      {available.length > 0 && <div className="grid gap-2" data-suggestions>
        <h3 className="m-0 text-14 font-semibold text-primary">{t("types.suggestions")}</h3>
        <p className="m-0 text-13 text-secondary">{t("types.suggestionsHint")}</p>
        <RowList>{available.map((suggestion) => <Row key={suggestion.key}>
          <span className="flex flex-1 items-start gap-2">
            <span className="mt-0.5"><TypeIconMark icon={suggestion.icon} color={suggestion.color} /></span>
            <span className="grid gap-0.5"><span className="font-medium">{suggestion.name}</span><span className="text-13 text-secondary">{typeDescriptionText(suggestion)}</span></span>
          </span>
          <button type="button" className="secondary" onClick={() => void run("create_work_item_type", { name: suggestion.name, icon: suggestion.icon, color: suggestion.color, description: suggestion.description }, "types.failed")}>
            {replaceAll(t("types.addSuggestion"), { name: suggestion.name })}
          </button>
        </Row>)}</RowList>
      </div>}
      <PropertiesBlock types={types} properties={properties} onRun={run} canReorder={canReorder} />
      {note && <Note note={note} error={error} />}
    </>}
  </SettingsBlock>;
}

function TypeRow({ type, types, properties, onRun, grip, canUp, canDown, onMove }: { type: WorkItemType; types: WorkItemType[]; properties: CustomProperty[]; onRun: (name: string, body: Record<string, unknown>, failedKey: MessageKey) => Promise<boolean>; grip: React.ReactNode; canUp: boolean; canDown: boolean; onMove: (delta: -1 | 1) => void }) {
  const [editing, setEditing] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const [moveTo, setMoveTo] = React.useState("");
  const [dropValues, setDropValues] = React.useState(false);
  const reasonId = React.useId();
  // The description in the interface language; a default that is left untouched is saved as it was stored, so it keeps following the language.
  const shownDescription = typeDescriptionText(type);
  const others = types.filter((other) => other.id !== type.id);
  // The only type cannot go: the button stays focusable so that it can say why, in a tooltip and in its accessible description.
  const cannotDelete = types.length <= 1;
  return <>
    {grip}
    <span className="grid min-w-0 flex-1 gap-3">
      <span className="flex flex-wrap items-start justify-between gap-3">
        <span className="flex min-w-0 items-start gap-2">
          <span className="mt-0.5"><TypeIconMark icon={type.icon} color={type.color} /></span>
          <span className="grid min-w-0 gap-0.5">
            <span className="font-medium">{type.name}</span>
            {shownDescription && <span className="text-13 text-secondary">{shownDescription}</span>}
            <span className="text-12 text-tertiary">{type.workItems === 1 ? replaceAll(t("types.countOne"), { count: "1" }) : replaceAll(t("types.count"), { count: String(type.workItems) })}</span>
            {types[0]?.id === type.id && <span className="text-12 text-accent-text">{t("types.defaultForNew")}</span>}
          </span>
        </span>
        <span className="flex flex-wrap items-center gap-2">
          <button type="button" className="secondary" aria-expanded={editing} aria-label={replaceAll(t("types.editNamed"), { name: type.name })} onClick={() => { setEditing((value) => !value); setDeleting(false); }}>{t("types.edit")}</button>
          <button type="button" className="secondary aria-disabled:cursor-not-allowed aria-disabled:opacity-50" aria-disabled={cannotDelete || undefined} aria-label={replaceAll(t("types.deleteNamed"), { name: type.name })}
            title={cannotDelete ? t("types.deleteLast") : undefined} aria-describedby={cannotDelete ? reasonId : undefined}
            onClick={() => { if (cannotDelete) return; setDeleting((value) => !value); setEditing(false); }}>{t("types.delete")}</button>
          {cannotDelete && <span id={reasonId} className="sr-only">{t("types.deleteLast")}</span>}
          {grip && <SortMenu name={type.name} canUp={canUp} canDown={canDown} onMove={onMove} />}
        </span>
      </span>
      {editing && <TypeForm key={type.id} idPrefix={`type-${type.id}`} initial={{ name: type.name, icon: type.icon, color: type.color, description: shownDescription }} submitLabel={t("types.save")}
        onCancel={() => setEditing(false)}
        onSubmit={async (values: TypeValues) => { const ok = await onRun("update_work_item_type", { typeId: type.id, ...values, description: values.description === shownDescription ? type.description : values.description }, "types.failed"); if (ok) setEditing(false); return ok; }} />}
      {editing && <TypeProperties type={type} types={types} properties={properties} onRun={onRun} />}
      {deleting && <span className="grid gap-2 rounded-md border border-subtle bg-layer-1 p-3" role="group" aria-label={replaceAll(t("types.deleteHeading"), { name: type.name })} data-type-delete>
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
  </>;
}

type RunFn = (name: string, body: Record<string, unknown>, failedKey: MessageKey) => Promise<boolean>;

/**
 * The Properties section of a type's edit form: the properties this type uses, each with Remove from this type (which says how many
 * values it drops and asks first), then Add property (the form with this type ticked) and Use an existing property. Every change here
 * attaches or detaches this type only; the property itself is kept.
 */
function TypeProperties({ type, types, properties, onRun }: { type: WorkItemType; types: WorkItemType[]; properties: CustomProperty[]; onRun: RunFn }) {
  const [adding, setAdding] = React.useState(false);
  const [using, setUsing] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [removing, setRemoving] = React.useState<{ property: CustomProperty; count: number } | null>(null);
  const used = propertiesOfType(properties, type.id);
  const candidates = properties.filter((property) => !property.typeIds.includes(type.id));
  const needle = query.trim().toLowerCase();
  const matches = candidates.filter((property) => property.name.toLowerCase().includes(needle));
  const typeName = type.name;
  // The count comes from the server, so the confirmation names the values that will really be dropped.
  const askRemove = async (property: CustomProperty) => {
    const result = await actionResult<{ count: number }>("count_custom_property_values", { propertyId: property.id, typeId: type.id });
    if ("error" in result) return;
    setRemoving({ property, count: result.data.count });
  };
  const confirmRemove = async () => {
    if (!removing) return;
    const ok = await onRun("detach_custom_property_type", { propertyId: removing.property.id, typeId: type.id, ...(removing.count > 0 ? { dropPropertyValues: true } : {}) }, "types.failed");
    if (ok) setRemoving(null);
  };
  const removeText = (property: CustomProperty, count: number) => {
    const values = { name: property.name, type: typeName };
    if (count === 0) return replaceAll(t("types.removeNoValues"), values);
    if (count === 1) return replaceAll(t("types.removeValuesOne"), values);
    return replaceAll(t("types.removeValues"), { ...values, count: String(count) });
  };
  return <div className="grid gap-3 rounded-md border border-subtle bg-surface-1 p-4" data-type-properties>
    <div className="grid gap-1">
      <h4 className="m-0 text-14 font-semibold text-primary">{t("types.typeProperties")}</h4>
      <p className="m-0 text-13 text-secondary">{t("types.typePropertiesHint")}</p>
    </div>
    {used.length === 0 && <p className="m-0 text-13 text-secondary">{t("types.noTypeProperties")}</p>}
    {used.length > 0 && <ul className="m-0 grid list-none gap-2 p-0">
      {used.map((property) => {
        const onlyType = property.typeIds.length <= 1;
        const askingThis = removing?.property.id === property.id;
        return <li key={property.id} className="grid gap-2" data-type-property>
          <span className="flex flex-wrap items-center justify-between gap-2">
            <span className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{property.name}</span>
              <span className="rounded bg-layer-1 px-1.5 py-0.5 text-11 text-secondary">{t(`types.kind.${property.kind}`)}</span>
              {property.required && <span className="rounded bg-layer-1 px-1.5 py-0.5 text-11 font-medium text-secondary">{t("types.required")}</span>}
            </span>
            <span className="flex flex-wrap items-center gap-2">
              {onlyType && <span className="text-12 text-tertiary">{t("types.removeOnlyType")}</span>}
              <button type="button" className="secondary" aria-label={replaceAll(t("types.removeNamed"), { name: property.name })} disabled={onlyType}
                onClick={() => void askRemove(property)}>{t("types.removeFromType")}</button>
            </span>
          </span>
          {askingThis && <span className="grid gap-2 rounded-md border border-subtle bg-layer-1 p-3" role="group" aria-label={replaceAll(t("types.removeHeading"), { name: property.name, type: typeName })} data-type-property-remove>
            <span className="font-medium">{replaceAll(t("types.removeHeading"), { name: property.name, type: typeName })}</span>
            <span className="text-13 text-secondary">{removeText(property, removing.count)}</span>
            <span className="flex flex-wrap gap-2">
              <button type="button" onClick={() => void confirmRemove()}>{t("types.removeConfirm")}</button>
              <button type="button" className="secondary" onClick={() => setRemoving(null)}>{t("types.cancel")}</button>
            </span>
          </span>}
        </li>;
      })}
    </ul>}
    {adding && <AddProperty types={types} initialTypeIds={[type.id]} onCancel={() => setAdding(false)}
      onAdd={async (body) => { const ok = await onRun("create_custom_property", body, "types.failed"); if (ok) setAdding(false); return ok; }} />}
    {using && <div className="grid gap-2 rounded-md border border-subtle bg-layer-1 p-3" data-use-property>
      <span className="font-medium text-13">{t("types.useExisting")}</span>
      {candidates.length === 0 ? <p className="m-0 text-13 text-secondary">{t("types.useExistingEmpty")}</p> : <>
        {candidates.length > 6 && <input type="search" aria-label={t("types.searchProperties")} placeholder={t("types.searchProperties")} value={query} className="w-full" onChange={(event) => setQuery(event.target.value)} />}
        {matches.length === 0 ? <p className="m-0 text-13 text-secondary">{t("types.noPropertyMatch")}</p> : <ul className="m-0 grid list-none gap-2 p-0">
          {matches.map((property) => <li key={property.id} className="flex flex-wrap items-center justify-between gap-2">
            <span className="flex flex-wrap items-center gap-2 text-13">
              <span className="font-medium">{property.name}</span>
              <span className="rounded bg-layer-1 px-1.5 py-0.5 text-11 text-secondary">{t(`types.kind.${property.kind}`)}</span>
            </span>
            <button type="button" className="secondary" onClick={() => void onRun("attach_custom_property_type", { propertyId: property.id, typeId: type.id }, "types.failed")}>{replaceAll(t("types.useNamed"), { name: property.name })}</button>
          </li>)}
        </ul>}
      </>}
    </div>}
    <span className="flex flex-wrap gap-2">
      <button type="button" className="secondary" aria-expanded={adding} onClick={() => { setAdding((value) => !value); setUsing(false); }}>{t("types.addPropertyHere")}</button>
      <button type="button" className="secondary" aria-expanded={using} onClick={() => { setUsing((value) => !value); setAdding(false); setQuery(""); }}>{t("types.useExisting")}</button>
    </span>
  </div>;
}

function AddType({ onAdd }: { onAdd: (body: Record<string, unknown>) => Promise<boolean> }) {
  // A new key clears the form after a type is added.
  const [formKey, setFormKey] = React.useState(0);
  return <section className="grid gap-3" data-add-type>
    <h3 className="m-0 text-14 font-semibold text-primary">{t("types.add")}</h3>
    <TypeForm key={formKey} idPrefix="add-type" initial={{ name: "", icon: "task", color: "#6b7280", description: "" }} submitLabel={t("types.add")}
      onSubmit={async (values) => { const ok = await onAdd(values); if (ok) setFormKey((key) => key + 1); return ok; }} />
  </section>;
}

function PropertiesBlock({ types, properties, onRun, canReorder }: { types: WorkItemType[]; properties: CustomProperty[]; onRun: (name: string, body: Record<string, unknown>, failedKey: MessageKey) => Promise<boolean>; canReorder: boolean }) {
  const typeName = (id: string) => types.find((type) => type.id === id)?.name ?? "";
  return <div className="grid gap-3" data-properties>
    <h3 className="m-0 text-14 font-semibold text-primary">{t("types.properties")}</h3>
    <p className="m-0 text-13 text-secondary">{t("types.propertiesExplain")}</p>
    {properties.length === 0 && <p className="m-0 text-13 text-secondary">{t("types.noProperties")}</p>}
    <SortableList ids={properties.map((property) => property.id)} disabled={!canReorder} label={(id) => properties.find((property) => property.id === id)?.name ?? ""}
      onReorder={(ids) => void onRun("reorder_custom_properties", { propertyIds: ids }, "types.failed")}
      renderRow={(id, grip) => {
        const index = properties.findIndex((property) => property.id === id);
        const move = (delta: -1 | 1) => {
          const ids = properties.map((property) => property.id);
          [ids[index], ids[index + delta]] = [ids[index + delta]!, ids[index]!];
          void onRun("reorder_custom_properties", { propertyIds: ids }, "types.failed");
        };
        return <PropertyRow property={properties[index]!} types={types} typeName={typeName} onRun={onRun} grip={canReorder ? grip : null}
          canUp={index > 0} canDown={index < properties.length - 1} onMove={move} />;
      }} />
    <AddProperty types={types} onAdd={(body) => onRun("create_custom_property", body, "types.failed")} />
  </div>;
}

function PropertyRow({ property, types, typeName, onRun, grip, canUp, canDown, onMove }: { property: CustomProperty; types: WorkItemType[]; typeName: (id: string) => string; onRun: (name: string, body: Record<string, unknown>, failedKey: MessageKey) => Promise<boolean>; grip: React.ReactNode; canUp: boolean; canDown: boolean; onMove: (delta: -1 | 1) => void }) {
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
  return <>
    {grip}
    <span className="grid min-w-0 flex-1 gap-0.5">
      <span className="flex flex-wrap items-center gap-2"><span className="font-medium">{property.name}</span>
        <span className="rounded bg-layer-1 px-1.5 py-0.5 text-11 text-secondary">{t(`types.kind.${property.kind}`)}</span>
        {property.required && <span className="rounded bg-layer-1 px-1.5 py-0.5 text-11 font-medium text-secondary">{t("types.required")}</span>}</span>
      <span role="group" aria-label={t("types.belongsTo")} className="flex flex-wrap items-center gap-1.5" data-used-by>
        {property.typeIds.length === 0 ? <span className="text-12 text-tertiary">{t("types.none")}</span>
          : property.typeIds.map((id) => <span key={id} className="rounded-full border border-subtle px-2 py-0.5 text-11 text-secondary" data-used-by-type>{typeName(id)}</span>)}
      </span>
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
      {grip && <SortMenu name={property.name} canUp={canUp} canDown={canDown} onMove={onMove} />}
    </span>
  </>;
}

function AddProperty({ types, initialTypeIds, onAdd, onCancel }: { types: WorkItemType[]; initialTypeIds?: string[]; onAdd: (body: Record<string, unknown>) => Promise<boolean>; onCancel?: () => void }) {
  const [name, setName] = React.useState("");
  const [kind, setKind] = React.useState<PropertyKind>("text");
  const [options, setOptions] = React.useState("");
  const [required, setRequired] = React.useState(false);
  const [typeIds, setTypeIds] = React.useState<string[]>(initialTypeIds ?? (types[0] ? [types[0].id] : []));
  const usedById = React.useId();
  const isOption = optionKinds.includes(kind);
  const ready = name.trim() !== "" && typeIds.length > 0 && (!isOption || options.trim() !== "");
  return <form className="grid gap-4 rounded-md border border-subtle p-3" data-add-property onSubmit={async (event) => {
    event.preventDefault();
    if (!ready) return;
    const lines = options.split("\n").map((line) => line.trim()).filter(Boolean);
    const ok = await onAdd({ name: name.trim(), kind, required, typeIds, ...(isOption ? { options: lines } : {}) });
    if (ok) { setName(""); setOptions(""); setRequired(false); }
  }}>
    <h3 className="m-0 text-14 font-semibold text-primary">{t("types.addProperty")}</h3>
    <div className="flex flex-wrap items-start gap-4">
      <label className="grid content-start gap-1.5 text-13">{t("types.propertyName")}<input required value={name} maxLength={60} onChange={(event) => setName(event.target.value)} /></label>
      <label className="grid content-start gap-1.5 text-13">{t("types.propertyKind")}<select value={kind} onChange={(event) => setKind(event.target.value as PropertyKind)}>
        {propertyKinds.map((value) => <option key={value} value={value}>{t(`types.kind.${value}`)}</option>)}
      </select></label>
      {isOption && <label className="grid min-w-48 flex-1 content-start gap-1.5 text-13">{t("types.optionsOnePerLine")}<textarea rows={3} value={options} onChange={(event) => setOptions(event.target.value)} /></label>}
    </div>
    <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
      <label className="flex items-center gap-2 text-13"><input type="checkbox" checked={required} onChange={(event) => setRequired(event.target.checked)} />{t("types.requiredToggle")}</label>
      <div role="group" aria-labelledby={usedById} className="flex flex-wrap items-center gap-x-4 gap-y-2 text-13">
        <span id={usedById} className="font-medium text-primary">{t("types.belongsTo")}</span>
        {types.map((type) => <label key={type.id} className="flex items-center gap-1.5"><input type="checkbox" checked={typeIds.includes(type.id)} onChange={(event) => setTypeIds(event.target.checked ? [...typeIds, type.id] : typeIds.filter((id) => id !== type.id))} />{type.name}</label>)}
      </div>
    </div>
    <div className="flex flex-wrap gap-2">
      <button type="submit" disabled={!ready}>{t("types.addProperty")}</button>
      {onCancel && <button type="button" className="secondary" onClick={onCancel}>{t("types.cancel")}</button>}
    </div>
  </form>;
}
