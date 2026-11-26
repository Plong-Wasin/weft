import React from "react";
import { handleImeSafeEnter } from "./ime";
import { CheckSquare, Layers, FileText, ClipboardList, Calendar, Flag, Target, Milestone, Kanban, ListTodo, Briefcase, Folder, BookOpen, Pencil, Timer, Rocket, Puzzle, Users, User, UserCheck, Handshake, GraduationCap, Heart, Smile, HandHelping, Building2, Crown, Inbox, Mail, MessageSquare, Megaphone, Phone, Bell, Send, Share2, Newspaper, Mic, Video, AtSign, Bug, BadgeCheck, CircleCheck, CircleAlert, TriangleAlert, ShieldCheck, Lock, Clock, Zap, Flame, Star, ThumbsUp, Ban, RefreshCw, Hourglass, Package, Box, ShoppingCart, CreditCard, Wallet, Receipt, Gift, Key, Wrench, Hammer, Lightbulb, Camera, MapPin, Truck, Tag, Code, Terminal, Database, Server, Cloud, Globe, Cpu, GitBranch, Smartphone, Monitor, Wifi, Bot, Sparkles, Shield, Leaf, TreePine, Sun, Moon, Droplet, Mountain, Flower2, PawPrint } from "lucide-react";
import { resolveTypeIcon, translate, typeIcons, type MessageKey, type TypeIcon } from "@weft/shared";
import { action } from "./api";
import { SingleSelect } from "./property-dropdowns";
import { editorPalette } from "../../../packages/actions/src/wiki-editor-extensions";
import type { Member, Project } from "./types";

import { Checkbox } from "@/ui/checkbox";
import { Input } from "@/ui/input";
import { Switch } from "@/ui/switch";
const t = (key: string) => translate(key as MessageKey);

export { typeIcons, type TypeIcon };
export const propertyKinds = ["text", "number", "date", "boolean", "url", "dropdown", "multi_select", "person"] as const;
export type PropertyKind = (typeof propertyKinds)[number];
export const optionKinds: ReadonlyArray<PropertyKind> = ["dropdown", "multi_select"];

export type WorkItemType = { id: string; projectId: string; name: string; icon: TypeIcon; color: string; description: string; position: number; workItems: number };
export type PropertyOption = { id: string; label: string; position: number };
export type CustomProperty = { id: string; projectId: string; name: string; kind: PropertyKind; required: boolean; defaultValue: unknown; position: number; options: PropertyOption[]; typeIds: string[] };
export type PropertyValue = { propertyId: string; value: unknown };
export type Suggestion = { key: string; name: string; icon: TypeIcon; color: string; description: string };

/** The drawn icon of every key in the shared list (@weft/shared type-icons). A missing key is a type error. */
const iconComponents: Record<TypeIcon, React.ComponentType<{ size?: number; style?: React.CSSProperties; "aria-hidden"?: boolean }>> = {
"task": CheckSquare,
  "group": Layers,
  "document": FileText,
  "clipboard-list": ClipboardList,
  "calendar": Calendar,
  "flag": Flag,
  "target": Target,
  "milestone": Milestone,
  "kanban": Kanban,
  "list-todo": ListTodo,
  "briefcase": Briefcase,
  "folder": Folder,
  "book-open": BookOpen,
  "pencil": Pencil,
  "timer": Timer,
  "rocket": Rocket,
  "puzzle": Puzzle,
  "users": Users,
  "user": User,
  "user-check": UserCheck,
  "handshake": Handshake,
  "graduation-cap": GraduationCap,
  "heart": Heart,
  "smile": Smile,
  "hand-helping": HandHelping,
  "building": Building2,
  "crown": Crown,
  "request": Inbox,
  "mail": Mail,
  "message-square": MessageSquare,
  "megaphone": Megaphone,
  "phone": Phone,
  "bell": Bell,
  "send": Send,
  "share": Share2,
  "newspaper": Newspaper,
  "mic": Mic,
  "video": Video,
  "at-sign": AtSign,
  "bug": Bug,
  "approval": BadgeCheck,
  "circle-check": CircleCheck,
  "circle-alert": CircleAlert,
  "triangle-alert": TriangleAlert,
  "shield-check": ShieldCheck,
  "lock": Lock,
  "clock": Clock,
  "zap": Zap,
  "flame": Flame,
  "star": Star,
  "thumbs-up": ThumbsUp,
  "ban": Ban,
  "refresh-cw": RefreshCw,
  "hourglass": Hourglass,
  "package": Package,
  "box": Box,
  "shopping-cart": ShoppingCart,
  "credit-card": CreditCard,
  "wallet": Wallet,
  "receipt": Receipt,
  "gift": Gift,
  "key": Key,
  "wrench": Wrench,
  "hammer": Hammer,
  "lightbulb": Lightbulb,
  "camera": Camera,
  "map-pin": MapPin,
  "truck": Truck,
  "tag": Tag,
  "code": Code,
  "terminal": Terminal,
  "database": Database,
  "server": Server,
  "cloud": Cloud,
  "globe": Globe,
  "cpu": Cpu,
  "git-branch": GitBranch,
  "smartphone": Smartphone,
  "monitor": Monitor,
  "wifi": Wifi,
  "bot": Bot,
  "sparkles": Sparkles,
  "shield": Shield,
  "leaf": Leaf,
  "tree-pine": TreePine,
  "sun": Sun,
  "moon": Moon,
  "droplet": Droplet,
  "mountain": Mountain,
  "flower": Flower2,
  "paw-print": PawPrint,
};

/**
 * The colours a type can take from the swatches: the editor palette, then the neutral grey of the default Task type.
 * The palette colours have a light and a dark value under the editor-palette tokens, so they follow the theme (see themeColour).
 */
export const typeSwatches: ReadonlyArray<string> = [...editorPalette, "#6b7280"];

/** How a type colour paints on screen: a palette colour uses its theme token (light and dark values); any other colour is itself. */
export function themeColour(color: string) {
  const index = editorPalette.indexOf(color.toLowerCase() as (typeof editorPalette)[number]);
  return index >= 0 ? `var(--editor-palette-${index})` : color;
}

/** The small icon of a type, drawn in the type's colour. */
export function TypeIconMark({ icon, color, size = 14 }: { icon: string; color: string; size?: number }) {
  const key = resolveTypeIcon(icon);
  const Icon = iconComponents[key];
  return <Icon aria-hidden data-type-icon={key} size={size} style={{ color: themeColour(color) }} />;
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
      const label = <span className="flex items-center gap-2 font-medium text-foreground">{property.name}{property.required && <span className="rounded bg-muted px-1.5 py-0.5 text-11 font-medium text-muted-foreground" data-required-marker>{t("types.required")}</span>}</span>;
      const hint = <span className="text-12 text-muted-foreground">{t(`types.kindHint.${property.kind}`)}</span>;
      if (property.kind === "boolean") {
        return <label key={property.id} htmlFor={id} className="flex items-center gap-2 text-13">
          <Switch id={id} disabled={disabled} checked={value === true} onChange={(event) => onChange(property, event.target.checked ? true : null)} />
          <span className="font-medium text-foreground">{property.name}</span>{property.required && <span className="rounded bg-muted px-1.5 py-0.5 text-11 font-medium text-muted-foreground" data-required-marker>{t("types.required")}</span>}
        </label>;
      }
      if (property.kind === "multi_select") {
        const selected = Array.isArray(value) ? value as string[] : [];
        return <fieldset key={property.id} className={fieldClass} data-property={property.id}>
          <legend className="mb-1">{label}</legend>
          <div className="flex flex-wrap gap-2">{property.options.map((option) => <label key={option.id} className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-13">
            <Checkbox disabled={disabled} checked={selected.includes(option.id)} onChange={(event) => {
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
        <Input id={id} type={inputType} disabled={disabled} value={inputValue(value)} maxLength={property.kind === "text" ? 2000 : undefined}
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
  return <Input id={id} type={type} disabled={disabled} value={draft} maxLength={maxLength} onChange={(event) => setDraft(event.target.value)}
    onBlur={commit} onKeyDown={(event) => { if (type !== "number") handleImeSafeEnter(event.nativeEvent, commit); }} />;
}

/** Plain suggestions for the settings page; the server lists them too, so the page never hard-codes a second copy. */
export async function loadSuggestions(projectId: string) {
  return (await action<Suggestion[]>("list_work_item_type_suggestions", { projectId })) ?? [];
}
