import React from "react";
import { getLocale, isLocale, locales, setLocale, subscribeLocale, translate, type Locale } from "@weft/shared";
import { Select, SelectContent, SelectItem, SelectItemText, SelectTrigger, SelectValue } from "./ui/select";

const STORAGE_KEY = "weft.locale";

export function detectLocale(stored: string | null, browserLanguage: string | undefined, serverDefault: string | null = null): Locale {
  if (isLocale(stored)) return stored;
  if (isLocale(serverDefault)) return serverDefault;
  return browserLanguage?.toLowerCase().startsWith("th") ? "th" : "en";
}

export function applyLocale(locale: Locale, root: { lang: string } = document.documentElement) {
  setLocale(locale);
  root.lang = locale;
}

function readStored(): string | null {
  try { return localStorage.getItem(STORAGE_KEY); } catch { return null; }
}

/** Before sign-in there is no user setting: use the last choice on this device, else the browser language. */
export function initLocale(serverDefault: string | null = null) {
  applyLocale(detectLocale(readStored(), navigator.language, serverDefault));
}

/** Re-renders the caller when the locale changes; `translate` reads the shared current locale. */
export function useLocale(): Locale {
  return React.useSyncExternalStore(subscribeLocale, getLocale);
}

/** Use the signed-in user's saved language (it follows them across devices). */
export function adoptUserLocale(locale: unknown, remember = true) {
  if (!isLocale(locale)) return;
  applyLocale(locale);
  if (remember) try { localStorage.setItem(STORAGE_KEY, locale); } catch { /* storage unavailable: the user setting still applies */ }
}

/**
 * The language to show once the session loads. A saved account language wins and follows the person across devices.
 * An unsaved one arrives as the instance default or English, which must not replace what the person already used
 * on the sign-up or sign-in screen: keep that language and save it to the account.
 */
export function resolveSessionLocale(user: { locale?: unknown; localeSaved?: boolean }, current: Locale): { apply: Locale; persist: boolean } {
  if (user.localeSaved === false) return { apply: current, persist: true };
  return { apply: isLocale(user.locale) ? user.locale : current, persist: false };
}

export function LanguageSwitch({ signedIn, save, defaultLocale = null }: { signedIn: boolean; save: (locale: Locale) => Promise<boolean>; defaultLocale?: string | null }) {
  const locale = useLocale();
  const [failed, setFailed] = React.useState(false);
  return <label className="flex items-center gap-1.5">{translate("language.label")}
    <Select value={locale} items={locales.map((code) => ({ value: code, label: translate(`language.${code}`, code) }))} onValueChange={async (value: string | null) => {
      if (!isLocale(value)) return;
      adoptUserLocale(value);
      setFailed(signedIn ? !(await save(value)) : false);
    }}>
      <SelectTrigger aria-label={translate("language.label")} className="w-auto"><SelectValue /></SelectTrigger>
      <SelectContent>{locales.map((code) => <SelectItem key={code} value={code}><SelectItemText>{translate(`language.${code}`, code)}</SelectItemText></SelectItem>)}</SelectContent>
    </Select>
    {defaultLocale && <small className="basis-full text-tertiary">{translate("language.instanceDefault", locale).replace("{language}", translate(`language.${defaultLocale}` as never, locale))}</small>}
    {failed && <small role="alert"> {translate("language.saveFailed")}</small>}
  </label>;
}
