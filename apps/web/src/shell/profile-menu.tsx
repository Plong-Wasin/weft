import React from "react";
import { Check, Keyboard, KeyRound, LockKeyhole, LogOut, Mail, MonitorSmartphone } from "lucide-react";
import { Link } from "react-router";
import { locales, translate, translateDynamic, type Locale } from "@weft/shared";
import { action, api } from "../api";
import { adoptUserLocale, useLocale } from "../locale";
import { themes, useTheme } from "../theme";
import type { Current } from "../types";
import { Popover, menuItemClass } from "./popover";
import { Avatar } from "../avatar";
import { paths } from "../routes";
import { authClient } from "../auth-client";

/** Profile menu: who is signed in, language, theme (light, dark, system), sign out. */
export function ProfileMenu({ user, signOut }: { user: Current["user"]; signOut: () => Promise<void> }) {
  const locale = useLocale();
  const [theme, setTheme] = useTheme();
  const [failed, setFailed] = React.useState(false);
  const [changingPassword, setChangingPassword] = React.useState(false);
  const [passwordIssue, setPasswordIssue] = React.useState<string | null>(null);
  const [passwordMinimum, setPasswordMinimum] = React.useState(10);
  const [currentPassword, setCurrentPassword] = React.useState("");
  const [newPassword, setNewPassword] = React.useState("");
  const [microsoftEnabled, setMicrosoftEnabled] = React.useState(false);
  const [linkFailed, setLinkFailed] = React.useState(false);
  React.useEffect(() => { void fetch(`${api}/api/config`).then(async (response): Promise<{ minPasswordLength?: number }> => response.ok ? await response.json() as { minPasswordLength?: number } : {}).then((config) => { if (Number.isInteger(config.minPasswordLength) && (config.minPasswordLength ?? 0) > 0) setPasswordMinimum(config.minPasswordLength!); }).catch(() => {}); }, []);
  React.useEffect(() => {
    let active = true;
    void fetch(`${api}/api/auth/settings`, { credentials: "include" }).then((response) => response.json() as Promise<{ microsoftSignInEnabled?: boolean }>).then((settings) => {
      if (active) setMicrosoftEnabled(settings.microsoftSignInEnabled === true);
    }).catch(() => {});
    return () => { active = false; };
  }, []);
  async function changePassword(event: React.FormEvent) {
    event.preventDefault(); setPasswordIssue(null);
    const result = await authClient.changePassword({ currentPassword, newPassword });
    if (result.error) {
      const code = (result.error as { code?: string }).code ?? result.error.message;
      setPasswordIssue(translateDynamic(`auth.passwordError.${code}`) ?? translate("auth.changePasswordFailed"));
      return;
    }
    setChangingPassword(false); setCurrentPassword(""); setNewPassword("");
  }
  async function linkMicrosoft() {
    setLinkFailed(false);
    const result = await authClient.linkSocial({ provider: "microsoft-entra-id", callbackURL: window.location.href });
    if (result.error) setLinkFailed(true);
    else if (result.data?.url) window.location.assign(result.data.url);
    else setLinkFailed(true);
  }
  async function chooseLocale(next: Locale) {
    adoptUserLocale(next);
    setFailed((await action("set_my_locale", { locale: next })) === null);
  }
  const heading = "px-2.5 pb-1 pt-2 text-12 font-medium text-tertiary";
  return <Popover label={translate("profile.menu")} align="right" panelClassName="w-64"
    trigger={<Avatar name={user.name} id={user.id} size="md" />}>
    {() => <>
      <div className="flex items-center gap-2 border-b border-subtle px-2.5 py-2"><Avatar name={user.name} id={user.id} size="md" /><div className="min-w-0"><p className="truncate text-14 font-medium">{user.name}</p><p className="truncate text-12 text-secondary">{user.email}</p></div></div>
      <p className={heading}>{translate("language.label")}</p>
      {locales.map((code) => <button type="button" role="menuitemradio" aria-checked={locale === code} key={code} className={menuItemClass} onClick={() => void chooseLocale(code)}>
        <span className="flex-1">{translate(`language.${code}`, code)}</span>{locale === code && <Check aria-hidden size={14} />}</button>)}
      {failed && <p role="alert" className="px-2.5 text-12 text-danger-text">{translate("language.saveFailed")}</p>}
      <button type="button" role="menuitem" className={`${menuItemClass} mt-1 border-t border-subtle`} onClick={() => { setChangingPassword(!changingPassword); setPasswordIssue(null); }}><LockKeyhole aria-hidden size={14} />{translate("auth.changePassword")}</button>
      {changingPassword && <form className="grid gap-2 px-2.5 py-2" onSubmit={(event) => void changePassword(event)}>
        <label className="grid gap-1 text-12 text-secondary">{translate("auth.currentPassword")}<input className="h-9 rounded border border-strong bg-layer-1 px-2 text-primary" type="password" required autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} /></label>
        <label className="grid gap-1 text-12 text-secondary">{translate("auth.newPassword")}<input className="h-9 rounded border border-strong bg-layer-1 px-2 text-primary" type="password" required minLength={passwordMinimum} maxLength={256} autoComplete="new-password" aria-describedby="change-password-hint" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} /></label>
        <p id="change-password-hint" className="m-0 text-11 text-tertiary">{translate("auth.passwordHint").replace("{min}", String(passwordMinimum))}</p>
        {passwordIssue && <p role="alert" className="m-0 text-12 text-danger-text">{passwordIssue}</p>}
        <button type="submit" className="h-8 rounded bg-accent-strong px-2 text-12 font-medium text-white">{translate("auth.savePassword")}</button>
      </form>}
      {microsoftEnabled && <>
        <button type="button" role="menuitem" className={`${menuItemClass} mt-1 border-t border-subtle`} onClick={() => void linkMicrosoft()}>{translate("auth.linkMicrosoft")}</button>
        {linkFailed && <p role="alert" className="px-2.5 text-12 text-danger-text">{translate("auth.linkMicrosoftFailed")}</p>}
      </>}
      <p className={heading}>{translate("theme.label")}</p>
      {themes.map((value) => <button type="button" role="menuitemradio" aria-checked={theme === value} key={value} className={menuItemClass} onClick={() => setTheme(value)}>
        <span className="flex-1">{translate(`theme.${value}`)}</span>{theme === value && <Check aria-hidden size={14} />}</button>)}
      <Link role="menuitem" className={`${menuItemClass} mt-1 border-t border-subtle`} to={paths.accountNotifications()}><Mail aria-hidden size={14} />{translate("email.menu")}</Link>
      <Link role="menuitem" className={menuItemClass} to={paths.apiTokens()}><KeyRound aria-hidden size={14} />{translate("tokens.title")}</Link>
      <Link role="menuitem" className={menuItemClass} to={paths.sessions()}><MonitorSmartphone aria-hidden size={14} />{translate("account.sessionsTitle")}</Link>
      <Link role="menuitem" className={menuItemClass} to={paths.shortcuts()}><Keyboard aria-hidden size={14} />{translate("shortcuts.title")}</Link>
      <button type="button" role="menuitem" className={`${menuItemClass} mt-1 border-t border-subtle`} onClick={() => void signOut()}><LogOut aria-hidden size={14} />{translate("auth.signOut")}</button>
    </>}
  </Popover>;
}
