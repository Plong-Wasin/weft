import React from "react";
import { Code2, Filter, Search, X } from "lucide-react";
import { translate, type MessageKey } from "@weft/shared";
import { dateFilters, hasFilters, type DateFilter, type Filters, type NamedFilter } from "./filter-pql";
import { Popover } from "./shell/popover";
import type { Option } from "./property-dropdowns";

const t = (key: string) => translate(key as MessageKey);
const ghost = "flex items-center gap-1.5 rounded-md border border-subtle bg-surface-1 px-2.5 py-1 text-13 font-medium text-primary hover:bg-layer-transparent-hover";
const chipClass = "flex items-center gap-1.5 rounded-md border border-subtle bg-layer-1 py-0.5 pl-2 pr-1 text-12 text-primary";

export type FilterSection = { key: NamedFilter; options: Option[] };

const rangeText = (range: { from: string; to: string }) => range.from && range.to ? `${range.from} – ${range.to}` : range.from ? `≥ ${range.from}` : `≤ ${range.to}`;

/** The Filters button with its picker; the chips and the PQL editor are separate pieces so the page can lay them out. */
export function FilterPicker({ sections, filters, count, onChange, onClear }: { sections: FilterSection[]; filters: Filters; count: number; onChange: (next: Filters) => void; onClear: () => void }) {
  const [search, setSearch] = React.useState("");
  const [open, setOpen] = React.useState<string | null>(null);
  const label = count > 0 ? t("layout.filtersActive").replace("{count}", String(count)) : t("layout.filters");
  const needle = search.trim().toLowerCase();
  const toggle = (key: NamedFilter, id: string, on: boolean) => onChange({ ...filters, [key]: on ? [...filters[key], id] : filters[key].filter((other) => other !== id) });
  return <Popover label={label} className={ghost} panelRole="dialog" panelClassName="grid w-72 max-w-[calc(100vw-2rem)] max-h-[70vh] gap-1 overflow-auto p-2" trigger={<><Filter aria-hidden size={14} /><span>{label}</span></>}>
    {() => <>
      <label className="relative my-0 block"><span className="sr-only">{t("layout.filter.search")}</span>
        <Search aria-hidden size={14} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-tertiary" />
        <input type="search" value={search} placeholder={t("layout.filter.search")} className="w-full pl-7" onChange={(event) => setSearch(event.target.value)} /></label>
      {sections.map((section) => {
        const shown = section.options.filter((option) => !needle || option.name.toLowerCase().includes(needle));
        if (needle && shown.length === 0) return null;
        const expanded = needle !== "" || open === section.key;
        const selected = filters[section.key].length;
        return <div key={section.key} className="grid gap-1">
          <button type="button" aria-expanded={expanded} className="flex w-full items-center justify-between rounded-md bg-transparent px-2 py-1.5 text-13 font-medium text-primary hover:bg-layer-transparent-hover" onClick={() => setOpen(open === section.key ? null : section.key)}>
            <span>{t(`layout.filter.${section.key}`)}</span>{selected > 0 && <span className="rounded bg-layer-1 px-1.5 text-11 text-secondary">{selected}</span>}</button>
          {expanded && <fieldset className="m-0 grid gap-0.5 border-0 p-0 px-1" aria-label={t(`layout.filter.${section.key}`)}>
            <legend className="sr-only">{t(`layout.filter.${section.key}`)}</legend>
            {shown.map((option) => <label key={option.id} className="my-0 flex items-center gap-2 rounded-md px-1.5 py-1 text-13 hover:bg-layer-transparent-hover">
              <input type="checkbox" checked={filters[section.key].includes(option.id)} onChange={(event) => toggle(section.key, option.id, event.target.checked)} />{option.icon}<span className="truncate">{option.name}</span></label>)}
          </fieldset>}
        </div>;
      })}
      {(!needle || dateFilters.some((key) => t(`layout.filter.${key}`).toLowerCase().includes(needle))) && dateFilters.map((key) => {
        const expanded = needle !== "" || open === key;
        const range = filters[key];
        return <div key={key} className="grid gap-1">
          <button type="button" aria-expanded={expanded} className="flex w-full items-center justify-between rounded-md bg-transparent px-2 py-1.5 text-13 font-medium text-primary hover:bg-layer-transparent-hover" onClick={() => setOpen(open === key ? null : key)}>
            <span>{t(`layout.filter.${key}`)}</span>{(range.from || range.to) && <span className="rounded bg-layer-1 px-1.5 text-11 text-secondary">1</span>}</button>
          {expanded && <fieldset className="m-0 grid gap-1 border-0 p-0 px-2" aria-label={t(`layout.filter.${key}`)}>
            <legend className="sr-only">{t(`layout.filter.${key}`)}</legend>
            <label className="my-0 grid gap-0.5 text-12 text-tertiary">{t("layout.filter.from")}<input type="date" value={range.from} onChange={(event) => onChange({ ...filters, [key]: { ...range, from: event.target.value } })} /></label>
            <label className="my-0 grid gap-0.5 text-12 text-tertiary">{t("layout.filter.to")}<input type="date" value={range.to} onChange={(event) => onChange({ ...filters, [key]: { ...range, to: event.target.value } })} /></label>
          </fieldset>}
        </div>;
      })}
      {count > 0 && <button type="button" className="secondary mt-1" onClick={onClear}>{t("layout.clear")}</button>}
    </>}
  </Popover>;
}

/** One chip per active filter ("State is Todo, Done") with a remove button, plus a chip for text the chips cannot show. */
export function FilterChips({ filters, sections, custom, onChange, onClear }: { filters: Filters; sections: FilterSection[]; custom: boolean; onChange: (next: Filters) => void; onClear: () => void }) {
  const chips: Array<{ id: string; text: string; remove: () => void }> = [];
  for (const section of sections) {
    const ids = filters[section.key];
    if (ids.length === 0) continue;
    const names = ids.map((id) => section.options.find((option) => option.id === id)?.name ?? id);
    chips.push({ id: section.key, text: `${t(`layout.filter.${section.key}`)}: ${names.join(", ")}`, remove: () => onChange({ ...filters, [section.key]: [] }) });
  }
  for (const key of dateFilters) {
    const range = filters[key];
    if (range.from || range.to) chips.push({ id: key, text: `${t(`layout.filter.${key as DateFilter}`)}: ${rangeText(range)}`, remove: () => onChange({ ...filters, [key]: { from: "", to: "" } }) });
  }
  if (custom) chips.push({ id: "custom", text: t("layout.filter.custom"), remove: onClear });
  if (chips.length === 0) return null;
  return <ul aria-label={t("layout.filter.active")} className="m-0 flex list-none flex-wrap items-center gap-1.5 p-0">
    {chips.map((chip) => <li key={chip.id} data-testid={`chip-${chip.id}`} className={chipClass}><span>{chip.text}</span>
      <button type="button" aria-label={t("layout.filter.remove").replace("{filter}", chip.text)} className="rounded bg-transparent p-0.5 text-secondary hover:bg-layer-transparent-hover hover:text-primary" onClick={chip.remove}><X aria-hidden size={12} /></button></li>)}
    {(hasFilters(filters) || custom) && <li><button type="button" className="rounded-md bg-transparent px-1.5 py-0.5 text-12 text-secondary hover:bg-layer-transparent-hover hover:text-primary" onClick={onClear}>{t("layout.clearAll")}</button></li>}
  </ul>;
}

/** The PQL text of the current filter, editable. Apply sends it to the page, which keeps the last good result when the text is invalid. */
export function PqlEditor({ text, error, onApply }: { text: string; error: string | null; onApply: (text: string) => void }) {
  const [draft, setDraft] = React.useState(text);
  React.useEffect(() => setDraft(text), [text]);
  return <form className="my-0 grid gap-1.5 rounded-lg border border-subtle bg-layer-1 p-2" onSubmit={(event) => { event.preventDefault(); onApply(draft); }}>
    <label className="my-0 grid gap-1 text-12 font-medium text-tertiary">{t("layout.pql.label")}
      <textarea value={draft} rows={2} maxLength={2000} spellCheck={false} aria-invalid={error !== null} placeholder={t("layout.pql.placeholder")} className="font-mono text-13"
        onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); onApply(draft); } }} /></label>
    <div className="flex items-center gap-2"><button type="submit">{t("layout.pql.apply")}</button>
      {error && <p role="alert" data-testid="pql-error" className="my-0 text-13 text-danger-text">{error}</p>}</div>
  </form>;
}

export function PqlToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return <button type="button" aria-pressed={open} aria-label={t("layout.pql.toggle")} title={t("layout.pql.toggle")} className={`${ghost} ${open ? "bg-layer-1" : ""}`} onClick={onToggle}><Code2 aria-hidden size={14} /><span>PQL</span></button>;
}
