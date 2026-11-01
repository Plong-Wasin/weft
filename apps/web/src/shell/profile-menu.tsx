import React from "react";
import { Check, LogOut } from "lucide-react";
import { locales, translate, type Locale } from "@weft/shared";
import { action } from "../api";
import { adoptUserLocale, useLocale } from "../locale";
import { themes, useTheme } from "../theme";
import type { Current } from "../types";
import { Popover, menuItemClass } from "./popover";

/** Profile menu: who is signed in, language, theme (light, dark, system), sign out. */
export function ProfileMenu({ user, signOut }: { user: Current["user"]; signOut: () => Promise<void> }) {
  const locale = useLocale();
  const [theme, setTheme] = useTheme();
  const [failed, setFailed] = React.useState(false);
  async function chooseLocale(next: Locale) {
    adoptUserLocale(next);
    setFailed((await action("set_my_locale", { locale: next })) === null);
  }
  const heading = "px-2.5 pb-1 pt-2 text-12 font-medium text-tertiary";
  return <Popover label={translate("profile.menu")} align="right" panelClassName="w-64"
    trigger={<span className="grid size-6 place-items-center rounded-full bg-layer-3 text-12 font-semibold text-primary">{user.name.slice(0, 1).toUpperCase()}</span>}>
    {() => <>
      <div className="border-b border-subtle px-2.5 py-2"><p className="truncate text-14 font-medium">{user.name}</p><p className="truncate text-12 text-secondary">{user.email}</p></div>
      <p className={heading}>{translate("language.label")}</p>
      {locales.map((code) => <button type="button" role="menuitemradio" aria-checked={locale === code} key={code} className={menuItemClass} onClick={() => void chooseLocale(code)}>
        <span className="flex-1">{translate(`language.${code}`, code)}</span>{locale === code && <Check aria-hidden size={14} />}</button>)}
      {failed && <p role="alert" className="px-2.5 text-12 text-danger-text">{translate("language.saveFailed")}</p>}
      <p className={heading}>{translate("theme.label")}</p>
      {themes.map((value) => <button type="button" role="menuitemradio" aria-checked={theme === value} key={value} className={menuItemClass} onClick={() => setTheme(value)}>
        <span className="flex-1">{translate(`theme.${value}`)}</span>{theme === value && <Check aria-hidden size={14} />}</button>)}
      <button type="button" role="menuitem" className={`${menuItemClass} mt-1 border-t border-subtle`} onClick={() => void signOut()}><LogOut aria-hidden size={14} />{translate("auth.signOut")}</button>
    </>}
  </Popover>;
}
