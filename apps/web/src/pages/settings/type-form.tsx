import { Button } from "@/ui/button";
import React from "react";
import { Palette } from "lucide-react";
import { searchTypeIcons, translate, typeIconGroups, type MessageKey } from "@weft/shared";
import { TypeIconMark, themeColour, typeSwatches, type TypeIcon } from "../../work-item-types";
import { handleImeSafeEnter } from "../../ime";

const t = (key: string) => translate(key as MessageKey);
const swatchNames = ["red", "orange", "yellow", "green", "cyan", "blue", "violet", "pink", "grey"] as const;
const isSwatch = (color: string) => typeSwatches.includes(color.toLowerCase());

export type TypeValues = { name: string; icon: TypeIcon; color: string; description: string };

/**
 * The one form for a work item type: name, colour, icon, description and a live preview. Edit opens it inside the row, Add a type
 * opens it at the top of the settings block. Two columns at desktop width, one column on narrow screens.
 */
export function TypeForm({ idPrefix, initial, submitLabel, onSubmit, onCancel }: {
  idPrefix: string; initial: TypeValues; submitLabel: string; onSubmit: (values: TypeValues) => Promise<boolean>; onCancel?: () => void;
}) {
  const [name, setName] = React.useState(initial.name);
  const [icon, setIcon] = React.useState<TypeIcon>(initial.icon);
  const [color, setColor] = React.useState(initial.color.toLowerCase());
  const [custom, setCustom] = React.useState(() => !isSwatch(initial.color));
  const [description, setDescription] = React.useState(initial.description);
  const [saving, setSaving] = React.useState(false);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (saving || !name.trim()) return;
    setSaving(true);
    await onSubmit({ name: name.trim(), icon, color, description: description.trim() });
    setSaving(false);
  };
  const nameId = `${idPrefix}-name`;
  const descriptionId = `${idPrefix}-description`;
  return <form className="grid gap-4 rounded-md border border-subtle bg-layer-1 p-4" data-type-form onSubmit={submit}>
    <div className="grid gap-4 md:grid-cols-2">
      <div className="grid content-start gap-1.5">
        <label htmlFor={nameId} className="text-13 font-medium text-primary">{t("types.name")}</label>
        <input id={nameId} required value={name} maxLength={40} className="w-full" onChange={(event) => setName(event.target.value)} />
      </div>
      <Field label={t("types.color")}>{(labelId) => <ColourChoice labelId={labelId} idPrefix={idPrefix} color={color} custom={custom} onPick={(next, nextCustom) => { setColor(next); setCustom(nextCustom); }} />}</Field>
      <Field label={t("types.icon")} className="md:col-span-2">{(labelId) => <IconChoice labelId={labelId} icon={icon} onPick={setIcon} />}</Field>
      <div className="grid content-start gap-1.5 md:col-span-2">
        <label htmlFor={descriptionId} className="text-13 font-medium text-primary">{t("types.description")}</label>
        <input id={descriptionId} value={description} maxLength={200} placeholder={t("types.descriptionHint")} className="w-full" onChange={(event) => setDescription(event.target.value)} />
      </div>
    </div>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <span data-type-preview className="inline-flex min-w-0 items-center gap-2 rounded-md border border-subtle bg-surface-1 px-2.5 py-1 text-13">
        <TypeIconMark icon={icon} color={color} />
        <span className={`truncate font-medium ${name.trim() ? "text-primary" : "text-tertiary"}`}>{name.trim() || t("types.previewEmpty")}</span>
      </span>
      <span className="flex flex-wrap gap-2">
        <Button type="submit" disabled={saving}>{submitLabel}</Button>
        {onCancel && <Button type="button" className="secondary" onClick={onCancel}>{t("types.cancel")}</Button>}
      </span>
    </div>
  </form>;
}

function Field({ label, className = "", children }: { label: string; className?: string; children: (labelId: string) => React.ReactNode }) {
  const labelId = React.useId();
  return <div className={`grid content-start gap-1.5 ${className}`}>
    <span id={labelId} className="text-13 font-medium text-primary">{label}</span>
    {children(labelId)}
  </div>;
}

/**
 * Moves the selection with the arrow keys (Home and End jump to the ends) and moves the focus with it, as a radio group does.
 * One tab stop: the checked choice.
 */
function useChoiceKeys(count: number, select: (index: number) => void) {
  const refs = React.useRef<Array<HTMLButtonElement | null>>([]);
  const onKeyDown = (index: number) => (event: React.KeyboardEvent) => {
    const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    let target = step !== 0 ? (index + step + count) % count : event.key === "Home" ? 0 : event.key === "End" ? count - 1 : -1;
    if (target < 0) return;
    event.preventDefault();
    select(target);
    refs.current[target]?.focus();
  };
  return { refs, onKeyDown };
}

const choiceBase = "inline-flex items-center justify-center rounded-md border border-subtle bg-surface-1 text-secondary hover:bg-layer-transparent-hover focus-visible:outline-2 focus-visible:outline-accent-primary";
const choiceChecked = "border-transparent text-primary ring-2 ring-accent-primary ring-offset-2 ring-offset-layer-1";

/**
 * The icon of a type: a search field above a scrollable library of real icon buttons in headed groups, each named and shown as a tooltip.
 * Search matches the name, key and keywords in English and Thai. Enter picks the first match, Escape clears the search.
 */
function IconChoice({ labelId, icon, onPick }: { labelId: string; icon: TypeIcon; onPick: (icon: TypeIcon) => void }) {
  const [query, setQuery] = React.useState("");
  const matches = searchTypeIcons(query, (key) => t(`types.icon.${key}`));
  const selected = Math.max(0, matches.findIndex((entry) => entry.key === icon));
  const keys = useChoiceKeys(matches.length, (index) => onPick(matches[index]!.key));
  const shown = typeIconGroups.map((group) => ({ group, entries: matches.filter((entry) => entry.group === group) })).filter((section) => section.entries.length > 0);
  const onSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (handleImeSafeEnter(event.nativeEvent, () => { if (matches[0]) onPick(matches[0].key); })) return;
    if (event.key === "Escape" && query) {
      event.preventDefault();
      event.stopPropagation();
      setQuery("");
    }
  };
  return <div className="grid min-w-0 gap-2">
    <input type="search" aria-label={t("types.iconSearch")} placeholder={t("types.iconSearch")} autoComplete="off" value={query}
      onChange={(event) => setQuery(event.target.value)} onKeyDown={onSearchKeyDown}
      className="w-full rounded-md border border-subtle bg-surface-1 px-2.5 py-1.5 text-13 text-primary placeholder:text-tertiary" />
    <div role="radiogroup" aria-labelledby={labelId} data-icon-library className="max-h-56 overflow-y-auto overflow-x-hidden rounded-md border border-subtle bg-surface-1 p-2">
      {matches.length === 0 && <p className="px-1 py-1.5 text-13 text-tertiary">{t("types.iconNoMatch")}</p>}
      {shown.map(({ group, entries }) => <section key={group} data-icon-group={group} className="mb-2 last:mb-0">
        <h4 className="mb-1 text-11 font-medium uppercase tracking-wide text-tertiary">{t(`types.iconGroup.${group}`)}</h4>
        <div className="flex flex-wrap gap-1.5">
          {entries.map(({ key: value }) => {
            const index = matches.findIndex((entry) => entry.key === value);
            const checked = value === icon;
            const name = t(`types.icon.${value}`);
            return <Button key={value} ref={(element) => { keys.refs.current[index] = element; }} type="button" role="radio" aria-checked={checked} aria-label={name} title={name}
              tabIndex={index === selected ? 0 : -1} onKeyDown={keys.onKeyDown(index)} onClick={() => onPick(value)}
              className={`${choiceBase} size-9 ${checked ? choiceChecked : ""}`}>
              <TypeIconMark icon={value} color="currentColor" size={16} />
            </Button>;
          })}
        </div>
      </section>)}
    </div>
  </div>;
}

/** Nine swatches (the editor palette and grey) and a custom choice that opens a colour input for any colour. */
function ColourChoice({ labelId, idPrefix, color, custom, onPick }: { labelId: string; idPrefix: string; color: string; custom: boolean; onPick: (color: string, custom: boolean) => void }) {
  const customIndex = typeSwatches.length;
  const selected = custom || !isSwatch(color) ? customIndex : typeSwatches.indexOf(color);
  const keys = useChoiceKeys(customIndex + 1, (index) => index === customIndex ? onPick(color, true) : onPick(typeSwatches[index]!, false));
  const customId = `${idPrefix}-custom-colour`;
  return <div className="grid gap-2">
    <div role="radiogroup" aria-labelledby={labelId} className="flex flex-wrap gap-2">
      {typeSwatches.map((hex, index) => {
        const checked = !custom && hex === color.toLowerCase();
        const name = t(`types.colour.${swatchNames[index]}`);
        return <Button key={hex} ref={(element) => { keys.refs.current[index] = element; }} type="button" role="radio" aria-checked={checked} aria-label={name} title={name}
          tabIndex={index === selected ? 0 : -1} onKeyDown={keys.onKeyDown(index)} onClick={() => onPick(hex, false)}
          className={`${choiceBase} size-8 rounded-full ${checked ? choiceChecked : ""}`}>
          <span aria-hidden className="block size-5 rounded-full" style={{ background: themeColour(hex) }} />
        </Button>;
      })}
      <Button ref={(element) => { keys.refs.current[customIndex] = element; }} type="button" role="radio" aria-checked={custom || !isSwatch(color)} aria-label={t("types.colour.custom")} title={t("types.colour.custom")}
        tabIndex={selected === customIndex ? 0 : -1} onKeyDown={keys.onKeyDown(customIndex)} onClick={() => onPick(color, true)}
        className={`${choiceBase} size-8 rounded-full ${custom || !isSwatch(color) ? choiceChecked : ""}`}>
        <Palette aria-hidden size={16} />
      </Button>
    </div>
    {(custom || !isSwatch(color)) && <label htmlFor={customId} className="flex items-center gap-2 text-13 text-secondary">
      {t("types.colour.custom")}
      <input id={customId} type="color" value={color} onChange={(event) => onPick(event.target.value.toLowerCase(), true)} className="h-8 w-12 cursor-pointer p-0.5" />
    </label>}
  </div>;
}
