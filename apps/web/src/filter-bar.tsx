import { Button, buttonVariants } from "@/ui/button";
import React from "react";
import { Bot, Code2, Filter, Search, Sparkles, X } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { translate, type MessageKey } from "@weft/shared";
import { dateFilters, hasFilters, type DateFilter, type Filters, type NamedFilter } from "./filter-query";
import { Popover } from "./shell/popover";
import { requestFilterQuery, type FilterQueryScope } from "./ai-filter-query";
import { aiStatusKey, requestAiStatus } from "./ai-status";
import { AiOnly } from "./ai-flag";
import type { Option } from "./property-dropdowns";

import { Checkbox } from "@/ui/checkbox";
import { Input } from "@/ui/input";
import { DatePicker } from "@/ui/date-picker";
import { Textarea } from "@/ui/textarea";
import { cn } from "./lib/utils";
const t = (key: string) => translate(key as MessageKey);
const secondarySm = `${buttonVariants({ variant: "secondary", size: "sm" })} bg-transparent text-foreground`;
const chipClass = "flex items-center gap-1.5 rounded-md border border-transparent bg-muted py-0.5 pl-2 pr-1 text-12 text-foreground";

export type FilterSection = { key: NamedFilter; options: Option[] };

const rangeText = (range: { from: string; to: string }) => range.from && range.to ? `${range.from} – ${range.to}` : range.from ? `≥ ${range.from}` : `≤ ${range.to}`;

/** The Filters button with its picker; the chips and the filter query editor are separate pieces so the page can lay them out. */
export function FilterPicker({ sections, filters, count, onChange, onClear, compactOnPhone = false }: { sections: FilterSection[]; filters: Filters; count: number; onChange: (next: Filters) => void; onClear: () => void; compactOnPhone?: boolean }) {
  const [search, setSearch] = React.useState("");
  const [open, setOpen] = React.useState<string | null>(null);
  const label = count > 0 ? t("layout.filtersActive").replace("{count}", String(count)) : t("layout.filters");
  const needle = search.trim().toLowerCase();
  const matchingDates = dateFilters.filter((key) => !needle || t(`layout.filter.${key}`).toLowerCase().includes(needle));
  const matchingSections = sections.filter((section) => {
    const sectionMatches = t(`layout.filter.${section.key}`).toLowerCase().includes(needle);
    const shown = section.options.filter((option) => !needle || option.name.toLowerCase().includes(needle));
    return !needle || sectionMatches || shown.length > 0;
  });
  const hasMatches = matchingSections.length > 0 || matchingDates.length > 0;
  const toggle = (key: NamedFilter, id: string, on: boolean) => onChange({ ...filters, [key]: on ? [...filters[key], id] : filters[key].filter((other) => other !== id) });
  return <Popover label={label} className={cn(secondarySm, compactOnPhone && "phone-layout:size-11 phone-layout:shrink-0 phone-layout:justify-center phone-layout:p-0")} panelRole="dialog" panelClassName="grid w-72 max-w-[calc(100vw-2rem)] max-h-[min(32rem,calc(100dvh-2rem))] gap-1 overflow-auto p-2" trigger={<><Filter aria-hidden size={14} /><span className={compactOnPhone ? "phone-layout:sr-only" : undefined}>{label}</span></>}>
    {() => <>
      <label className="relative my-0 block"><span className="sr-only">{t("layout.filter.search")}</span>
        <Search aria-hidden size={14} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <Input type="search" value={search} placeholder={t("layout.filter.search")} className="min-h-9 w-full rounded-md border border-input bg-background py-2 pl-7 pr-2 text-sm text-foreground placeholder:text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11" onChange={(event) => setSearch(event.target.value)} /></label>
      {matchingSections.map((section) => {
        const sectionMatches = t(`layout.filter.${section.key}`).toLowerCase().includes(needle);
        const shown = section.options.filter((option) => !needle || sectionMatches || option.name.toLowerCase().includes(needle));
        const expanded = needle !== "" || open === section.key;
        const selected = filters[section.key].length;
        return <div key={section.key} className="grid gap-1">
          <Button variant="ghost" type="button" aria-expanded={expanded} className="flex w-full items-center justify-between rounded-md bg-transparent px-2.5 py-2 text-sm font-medium text-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11" onClick={() => setOpen(open === section.key ? null : section.key)}>
            <span>{t(`layout.filter.${section.key}`)}</span>{selected > 0 && <span className="rounded bg-muted px-1.5 text-xs text-muted-foreground">{selected}</span>}</Button>
          {expanded && <fieldset className="m-0 grid gap-0.5 border-0 p-0 px-1" aria-label={t(`layout.filter.${section.key}`)}>
            <legend className="sr-only">{t(`layout.filter.${section.key}`)}</legend>
            {shown.map((option) => {
              const optionLabelId = `filter-option-${section.key}-${option.id}`;
              return <div key={option.id} className="my-0 flex min-h-9 items-center gap-2 rounded-md px-1.5 py-1 text-sm text-foreground hover:bg-accent pointer-coarse:min-h-11" onClick={(event) => {
                if (!event.currentTarget.querySelector("[data-slot=checkbox]")?.contains(event.target as Node)) toggle(section.key, option.id, !filters[section.key].includes(option.id));
              }}>
                <Checkbox hitArea="overlay" aria-labelledby={optionLabelId} checked={filters[section.key].includes(option.id)} onChange={(event) => toggle(section.key, option.id, event.target.checked)} />{option.isAgent ? <span title={t("comments.agent")}><Bot aria-hidden size={14} className="text-muted-foreground" /></span> : option.icon}<span id={optionLabelId} className="thai-room truncate">{option.name}{option.isAgent && <> <span className="ml-1.5 text-xs text-muted-foreground">{t("comments.agent")}</span></>}</span>{option.codeCapable && <span className="inline-flex items-center gap-1 whitespace-nowrap rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground" title={t("agents.codeCapable")}><Code2 aria-hidden size={13} className="text-amber-700 dark:text-amber-400" />{t("agents.canEditCode")}</span>}
              </div>;
            })}
          </fieldset>}
        </div>;
      })}
      {matchingDates.map((key) => {
        const expanded = needle !== "" || open === key;
        const range = filters[key];
        return <div key={key} className="grid gap-1">
          <Button variant="ghost" type="button" aria-expanded={expanded} className="flex w-full items-center justify-between rounded-md bg-transparent px-2.5 py-2 text-sm font-medium text-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11" onClick={() => setOpen(open === key ? null : key)}>
            <span>{t(`layout.filter.${key}`)}</span>{(range.from || range.to) && <span className="rounded bg-muted px-1.5 text-xs text-muted-foreground">1</span>}</Button>
          {expanded && <fieldset className="m-0 grid gap-1 border-0 p-0 px-2" aria-label={t(`layout.filter.${key}`)}>
            <legend className="sr-only">{t(`layout.filter.${key}`)}</legend>
            <label className="my-0 grid gap-1 text-xs text-muted-foreground">{t("layout.filter.from")}<DatePicker label={t("layout.filter.from")} value={range.from} onChange={(value) => onChange({ ...filters, [key]: { ...range, from: value } })} /></label>
            <label className="my-0 grid gap-1 text-xs text-muted-foreground">{t("layout.filter.to")}<DatePicker label={t("layout.filter.to")} value={range.to} field="due" onChange={(value) => onChange({ ...filters, [key]: { ...range, to: value } })} /></label>
          </fieldset>}
        </div>;
      })}
      {needle && !hasMatches && <p role="status" className="m-0 px-2 py-2 text-sm text-muted-foreground">{t("layout.filter.noMatches")}</p>}
      {count > 0 && <Button type="button" className="mt-1 rounded-md border border-input bg-background text-sm font-medium text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11" onClick={onClear}>{t("layout.clear")}</Button>}
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
      <Button variant="ghost" type="button" aria-label={t("layout.filter.remove").replace("{filter}", chip.text)} className="bg-transparent p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground" onClick={chip.remove}><X aria-hidden size={12} /></Button></li>)}
    {(hasFilters(filters) || custom) && <li><Button variant="ghost" type="button" className="rounded-md bg-transparent px-1.5 py-0.5 text-12 text-muted-foreground hover:bg-accent hover:text-foreground" onClick={onClear}>{t("layout.clearAll")}</Button></li>}
  </ul>;
}

/** The filter query text of the current filter, editable. Apply sends it to the page, which keeps the last good result when the text is invalid. With `generate`, a plain-language request fills the text with a query the server already compiled; the user reviews it and applies it. */
export function FilterQueryEditor({ text, error, onApply, generate }: { text: string; error: string | null; onApply: (text: string) => void; generate?: FilterQueryScope }) {
  const [draft, setDraft] = React.useState(text);
  React.useEffect(() => setDraft(text), [text]);
  return <form className="my-0 grid gap-2 rounded-xl border border-transparent bg-muted p-3" onSubmit={(event) => { event.preventDefault(); onApply(draft); }}>
    {generate && <AiOnly><FilterQueryGenerate scope={generate} onQuery={setDraft} /></AiOnly>}
    <label className="my-0 grid gap-1 text-12 font-medium text-muted-foreground">{t("layout.filterQuery.label")}
      <Textarea value={draft} rows={2} maxLength={2000} spellCheck={false} aria-invalid={error !== null} placeholder={t("layout.filterQuery.placeholder")} className="font-mono text-13"
        onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); onApply(draft); } }} /></label>
    <div className="flex items-center gap-2"><Button type="submit">{t("layout.filterQuery.apply")}</Button>
      {error && <p role="alert" data-testid="filter-query-error" className="my-0 text-13 text-destructive">{error}</p>}</div>
  </form>;
}

/** The "describe it" row. It never applies anything: the query lands in the editor below. */
function FilterQueryGenerate({ scope, onQuery }: { scope: FilterQueryScope; onQuery: (query: string) => void }) {
  const [request, setRequest] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [failure, setFailure] = React.useState<string | null>(null);
  // A workspace page knows its workspace, so a missing key or a Guest hides the row; a project page does not, and the server answers instead.
  const { data: status } = useQuery({ queryKey: aiStatusKey(scope.workspaceId ?? ""), queryFn: () => requestAiStatus(scope.workspaceId!), enabled: scope.workspaceId !== undefined, staleTime: 60_000 });
  if (status && (!status.configured || !status.canAssist)) return null;
  async function run() {
    if (!request.trim() || busy) return;
    setBusy(true); setFailure(null);
    const result = await requestFilterQuery(scope, request.trim());
    setBusy(false);
    if ("query" in result) onQuery(result.query); else setFailure(result.error || t("layout.filterQuery.generate.failed"));
  }
  return <div className="my-0 grid gap-1">
    <label className="my-0 grid gap-1 text-12 font-medium text-muted-foreground">{t("layout.filterQuery.generate.label")}
      <span className="flex items-center gap-2">
        <Input type="text" value={request} maxLength={1000} placeholder={t("layout.filterQuery.generate.placeholder")} className="min-w-0 flex-1 text-13" onChange={(event) => setRequest(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); void run(); } }} />
        <Button type="button" variant="secondary" size="sm" className="bg-transparent text-foreground" disabled={busy || request.trim() === ""} onClick={() => void run()}><Sparkles aria-hidden size={14} /><span>{busy ? t("layout.filterQuery.generate.busy") : t("layout.filterQuery.generate.button")}</span></Button>
      </span></label>
    {failure && <p role="alert" data-testid="filter-query-generate-error" className="my-0 text-13 text-destructive">{failure}</p>}
  </div>;
}

export function FilterQueryToggle({ open, onToggle, className }: { open: boolean; onToggle: () => void; className?: string }) {
  return <Button type="button" variant="secondary" size="sm" className={cn("bg-transparent text-foreground aria-pressed:bg-muted", className)} aria-pressed={open} aria-label={t("layout.filterQuery.toggle")} title={t("layout.filterQuery.toggle")} onClick={onToggle}><Code2 aria-hidden size={14} /><span className="max-sm:sr-only">{t("layout.filterQuery.button")}</span></Button>;
}
