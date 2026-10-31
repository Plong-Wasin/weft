import React from 'react';
import { en } from './i18n-en';
import { th } from './i18n-th';

export type Locale = 'en' | 'th';
export type MessageKey = keyof typeof en;
const dictionaries: Record<Locale, Partial<Record<MessageKey, string>>> = { en, th };
const STORAGE_KEY = 'weft-locale';

function detect(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'en' || saved === 'th') return saved;
  } catch { /* storage can be blocked; fall through to the browser language */ }
  return (typeof navigator !== 'undefined' ? navigator.language : 'en').toLowerCase().startsWith('th') ? 'th' : 'en';
}

let current: Locale = detect();
const listeners = new Set<() => void>();
if (typeof document !== 'undefined') document.documentElement.lang = current;

export function getLocale(): Locale { return current; }

export function setLocale(next: Locale) {
  if (next === current) return;
  current = next;
  try { localStorage.setItem(STORAGE_KEY, next); } catch { /* the choice still applies for this session */ }
  document.documentElement.lang = next;
  listeners.forEach((listener) => listener());
}

/** Translates a key, filling `{name}` placeholders. A missing Thai string falls back to English. */
export function t(key: MessageKey, vars?: Record<string, string | number>): string {
  const template = dictionaries[current][key] ?? en[key] ?? key;
  return vars ? template.replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? '')) : template;
}

/** Subscribes a component to locale changes; call once near the top of every component that renders text. */
export function useLocale(): Locale {
  return React.useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, getLocale, getLocale);
}

const dateFormats: Record<Locale, string> = { en: 'en-GB', th: 'th-TH-u-ca-gregory' };

/** dd/MM/yyyy in both languages (Gregorian years; Buddhist-era display is a later option). */
export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return '';
  const date = typeof value === 'string' ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00` : value) : value;
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat(dateFormats[current], { day: '2-digit', month: '2-digit', year: 'numeric' }).format(date);
}

export function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) return '';
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat(dateFormats[current], { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat(dateFormats[current]).format(value);
}

/** Label for an enum value from the server (`priority.normal`, `relation.blocked_by`); unknown values show readable text, never a raw key. */
export function enumLabel(prefix: string, value: string | null | undefined): string {
  if (!value) return '';
  const key = `${prefix}.${value}` as MessageKey;
  return dictionaries[current][key] ?? en[key] ?? value.replace(/_/g, ' ');
}
