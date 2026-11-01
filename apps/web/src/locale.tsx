import React from "react";
import { getLocale, isLocale, locales, setLocale, subscribeLocale, translate, type Locale } from "@weft/shared";

const STORAGE_KEY = "weft.locale";

export function detectLocale(stored: string | null, browserLanguage: string | undefined): Locale {
  if (isLocale(stored)) return stored;
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
export function initLocale() {
  applyLocale(detectLocale(readStored(), navigator.language));
}

/** Re-renders the caller when the locale changes; `translate` reads the shared current locale. */
export function useLocale(): Locale {
  return React.useSyncExternalStore(subscribeLocale, getLocale);
}

/** Use the signed-in user's saved language (it follows them across devices). */
export function adoptUserLocale(locale: unknown) {
  if (!isLocale(locale)) return;
  applyLocale(locale);
  try { localStorage.setItem(STORAGE_KEY, locale); } catch { /* storage unavailable: the user setting still applies */ }
}

export function LanguageSwitch({ signedIn, save }: { signedIn: boolean; save: (locale: Locale) => Promise<boolean> }) {
  const locale = useLocale();
  const [failed, setFailed] = React.useState(false);
  return <label>{translate("language.label")}
    <select value={locale} onChange={async (event) => {
      const next = event.target.value as Locale;
      adoptUserLocale(next);
      setFailed(signedIn ? !(await save(next)) : false);
    }}>
      {locales.map((code) => <option key={code} value={code}>{translate(`language.${code}`, code)}</option>)}
    </select>
    {failed && <small role="alert"> {translate("language.saveFailed")}</small>}
  </label>;
}
