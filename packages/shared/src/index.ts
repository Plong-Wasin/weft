import { en } from "./en";
import { th } from "./th";

export const resources = { en, th } as const;

export type Locale = keyof typeof resources;
export type MessageKey = keyof typeof en;
export const locales = ["en", "th"] as const satisfies readonly Locale[];
export const defaultLocale: Locale = "en";

/** Suggests a short Project key from a name without transliterating non-Latin text. */
export function sanitizeProjectKey(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/^[0-9]+/, "").slice(0, 10);
}

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (locales as readonly string[]).includes(value);
}

let current: Locale = defaultLocale;
const listeners = new Set<() => void>();

/** The locale `translate` and the formatters use when none is passed. Browser UI sets it from the user's setting. */
export function getLocale(): Locale { return current; }
export function setLocale(locale: Locale): void {
  if (locale === current) return;
  current = locale;
  for (const listener of listeners) listener();
}
export function subscribeLocale(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function translate(key: MessageKey, locale: Locale = current): string {
  return resources[locale][key];
}

/** Date and time in the locale's own calendar (Thai uses the Buddhist era). */
export function formatDate(value: string | number | Date, locale: Locale = current, timeZone?: string): string {
  return new Intl.DateTimeFormat(locale === "th" ? "th-TH" : "en-US", { dateStyle: "medium", timeStyle: "short", ...(timeZone ? { timeZone } : {}) }).format(new Date(value));
}

export function formatNumber(value: number, locale: Locale = current): string {
  return new Intl.NumberFormat(locale === "th" ? "th-TH" : "en-US").format(value);
}

/** Translate a key built at run time (for example from a stored field name); `undefined` when no such key exists. */
export function translateDynamic(key: string, locale: Locale = current): string | undefined {
  return key in resources[locale] ? resources[locale][key as MessageKey] : undefined;
}
