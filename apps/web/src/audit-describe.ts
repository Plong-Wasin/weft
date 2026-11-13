import { translate, translateDynamic, type Locale } from "@weft/shared";

/** "maxConcurrentRuns" -> "Max concurrent runs": the fallback when no translated label exists. */
export function humanizeKey(key: string): string {
  const words = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim().toLowerCase();
  return words ? words[0]!.toUpperCase() + words.slice(1) : key;
}

/** What changed: the translated label for a server-written field, or a generic label for one this screen does not know yet. */
export function auditFieldLabel(field: string, locale?: Locale): string {
  return translateDynamic(`account.field.${field}`, locale) ?? translate("account.field.unknown", locale);
}

const idKey = /Id$|^userId$|^tokenId$|^ownerId$/;

function shown(value: unknown, locale?: Locale): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return translate(value ? "account.value.true" : "account.value.false", locale);
  if (typeof value === "object") return null;
  return String(value);
}

/** A short plain description of the change; the full values stay in the CSV export. Ids and nested values are left out. */
export function describeAuditValue(value: unknown, locale?: Locale): string {
  if (value === null || value === undefined) return "";
  if (typeof value !== "object") return shown(value, locale) ?? "";
  if (Array.isArray(value)) return "";
  const parts = Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => {
    if (idKey.test(key)) return [];
    const text = shown(item, locale);
    if (text === null) return [];
    return [`${translateDynamic(`account.detail.${key}`, locale) ?? humanizeKey(key)}: ${text}`];
  });
  return parts.join(" · ");
}
