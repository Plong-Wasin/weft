import { setIntegrationsEnabled } from "../integrations-flag";
import React from "react";
import { Navigate, Outlet, useMatch, useNavigate, useOutletContext } from "react-router";
import { translate } from "@weft/shared";
import { action, api } from "../api";
import { useLiveUpdates } from "../live-updates";
import { LanguageSwitch, adoptUserLocale, initLocale, useLocale } from "../locale";
import { paths } from "../routes";
import type { Current, Workspace } from "../types";
import { AuthScreen } from "./auth-screen";
import { ResetPasswordScreen } from "../pages/reset-password";
import { CommandPalette } from "../command-palette";
import { OnboardingShell, fieldClass, primaryButton } from "./auth-shell";
import { ThemeSwitch } from "./theme-switch";
import { ForcedPasswordReset, SecurityNotice } from "../pages/account-security";

export type RootContext = { current: Current; languageSwitch: React.ReactNode; signOut: () => Promise<void>; refresh: () => Promise<void> };
export const useRoot = () => useOutletContext<RootContext>();

function slugify(value: string) { return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); }

/** Workspace chooser and first-workspace form: shown at "/" when no workspace is open, and for an unknown workspace slug. */
export function WorkspaceChooser({ current, languageSwitch, signOut, refresh }: Pick<RootContext, "current" | "languageSwitch" | "signOut" | "refresh">) {
  const [workspaceName, setWorkspaceName] = React.useState("");
  const [slug, setSlug] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const navigate = useNavigate();
  const needsFirstWorkspace = current.workspaces.length === 0;

  async function createWorkspace(event: React.FormEvent) {
    event.preventDefault(); setError(null);
    const response = await fetch(`${api}/actions/create_workspace`, {
      method: "POST", credentials: "include", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: workspaceName, slug }),
    });
    if (!response.ok) { setError(translate("workspace.createFailed")); return; }
    const workspace = await response.json() as Workspace;
    await refresh();
    navigate(paths.home(workspace.slug));
  }

  const signOutAction = <>
    <span className="hidden text-secondary sm:inline">{current.user.email}</span>
    <button type="button" className="!h-auto !bg-transparent !p-0 font-semibold !text-accent-text hover:underline" onClick={() => void signOut()}>{translate("auth.signOut")}</button>
  </>;

  return <OnboardingShell action={signOutAction}>
    <h1 className="text-20 font-semibold">{needsFirstWorkspace ? translate("workspace.firstTitle") : translate("workspace.yourWorkspaces")}</h1>
    {current.workspaces.length > 0 && <ul className="grid gap-2">
      {current.workspaces.map((item) => <li key={item.id}><a className="block rounded-md border border-subtle px-3.5 py-3 text-14 font-medium !text-primary hover:bg-layer-1-hover" href={paths.home(item.slug)}>{item.name}</a></li>)}
    </ul>}
    {current.canCreateWorkspace && <form onSubmit={createWorkspace} className="grid gap-4">
      <label className="grid gap-1.5 text-13 font-medium text-secondary">{translate("workspace.name")}<input className={fieldClass} required value={workspaceName} onChange={(event) => {
        const value = event.target.value; setWorkspaceName(value);
        if (!slug || slug === slugify(workspaceName)) setSlug(slugify(value));
      }} /></label>
      <label className="grid gap-1.5 text-13 font-medium text-secondary">{translate("workspace.slug")}<input className={fieldClass} required pattern="[a-z0-9]+(-[a-z0-9]+)*" value={slug} onChange={(event) => setSlug(event.target.value)} /></label>
      <button className={primaryButton}>{translate("workspace.create")}</button>
    </form>}
    {needsFirstWorkspace && !current.canCreateWorkspace && <p className="text-14 text-secondary">{translate("workspace.noAccess")}</p>}
    {error && <p role="alert" className="text-13 text-danger-text">{error}</p>}
    <div className="flex items-center gap-4 pt-2 text-13 text-secondary">{languageSwitch}<ThemeSwitch /></div>
  </OnboardingShell>;
}

/** Top route: loads the signed-in user, shows the auth screen when there is none, and handles invite links. Everything below gets `current` through the outlet context. */
export function RootLayout() {
  useLocale();
  const navigate = useNavigate();
  const [current, setCurrent] = React.useState<Current | null | undefined>(undefined);
  const [defaultLocale, setDefaultLocale] = React.useState<string | null>(null);
  const [emailEnabled, setEmailEnabled] = React.useState(false);
  const [minPasswordLength, setMinPasswordLength] = React.useState(10);
  const [inviteError, setInviteError] = React.useState<string | null>(null);
  const [resetPending, setResetPending] = React.useState(false);
  const [resetNotice, setResetNotice] = React.useState<string | null>(null);
  const inviteToken = useMatch("/invite/:token")?.params.token ?? null;
  useLiveUpdates(Boolean(current), api);

  const refresh = React.useCallback(async () => {
    // The API answers every route with PASSWORD_RESET_REQUIRED until the person chooses a new password, so the reset screen is the only thing shown.
    const load = async (): Promise<Current | "reset" | null> => {
      const response = await fetch(`${api}/api/me`, { credentials: "include" });
      if (response.status === 403) {
        const body = await response.json().catch(() => null) as { code?: string; notice?: string | null } | null;
        if (body?.code === "PASSWORD_RESET_REQUIRED") { setResetNotice(body.notice ?? null); return "reset"; }
      }
      return response.ok ? await response.json() as Current : null;
    };
    let loaded = await load();
    // A pending reset redirects to the change-password screen, wherever the person was going.
    if (loaded === "reset") { setCurrent(null); setResetPending(true); navigate(paths.passwordChange(), { replace: true }); return; }
    setResetPending(false);
    // Saving the new password leaves the change-password screen for the home page.
    if (window.location.pathname === paths.passwordChange()) navigate("/", { replace: true });
    let data: Current | null = loaded;
    if (!data) { setCurrent(null); return; }
    adoptUserLocale(data.user.locale, data.user.localeSaved !== false);
    if (inviteToken) {
      const joined = await action<{ slug: string }>("accept_invite", { token: inviteToken });
      // Reload the user so the joined workspace is in the list before the workspace route opens.
      if (joined) { const reloaded = await load(); if (reloaded && reloaded !== "reset") data = reloaded; } else setInviteError(translate("invite.failed"));
      setCurrent(data);
      if (joined) navigate(paths.home(joined.slug), { replace: true });
      return;
    }
    setCurrent(data);
  }, [inviteToken, navigate]);
  React.useEffect(() => {
    void (async () => {
      const response = await fetch(`${api}/api/config`).catch(() => null);
      const config = response?.ok ? await response.json() as { defaultLocale?: string | null; minPasswordLength?: number; emailEnabled?: boolean; integrationsEnabled?: boolean } : {};
      setIntegrationsEnabled(config.integrationsEnabled === true);
      const language = config.defaultLocale ?? null;
      setEmailEnabled(config.emailEnabled === true);
      setMinPasswordLength(Number.isInteger(config.minPasswordLength) && (config.minPasswordLength ?? 0) > 0 ? config.minPasswordLength! : 10);
      setDefaultLocale(language);
      initLocale(language);
      await refresh();
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const signOut = React.useCallback(async () => {
    await fetch(`${api}/api/auth/sign-out`, { method: "POST", credentials: "include" });
    setResetPending(false);
    setCurrent(null);
  }, []);
  React.useEffect(() => {
    if (!current) return;
    const target = new URLSearchParams(window.location.search).get("cli_login");
    if (target?.startsWith("/api/cli/login?")) window.location.replace(new URL(target, api).toString());
  }, [current]);
  const languageSwitch = <LanguageSwitch signedIn={Boolean(current)} defaultLocale={defaultLocale} save={async (locale) => (await action("set_my_locale", { locale })) !== null} />;

  if (resetPending) return <ForcedPasswordReset minPasswordLength={minPasswordLength} notice={resetNotice} languageSwitch={languageSwitch} signOut={signOut} onDone={refresh} />;
  if (current === undefined) return null;
  if (window.location.pathname === paths.resetPassword()) return <ResetPasswordScreen minPasswordLength={minPasswordLength} api={api} languageSwitch={languageSwitch} />;
  if (current === null) return <AuthScreen api={api} inviteToken={inviteToken} onSignedIn={refresh} languageSwitch={languageSwitch} minPasswordLength={minPasswordLength} emailEnabled={emailEnabled} />;
  if (inviteToken) return <OnboardingShell>
    <h1 className="text-20 font-semibold">{translate("invite.title")}</h1>
    <p role={inviteError ? "alert" : "status"} className={`text-14 ${inviteError ? "text-danger-text" : "text-secondary"}`}>{inviteError ?? translate("invite.joining")}</p>
    {inviteError && <a href={paths.home("")} className="text-14 font-medium">{translate("invite.goHome")}</a>}
  </OnboardingShell>;
  const notice = current.account?.securityNotice ?? null;
  return <>
    <Outlet context={{ current, languageSwitch, signOut, refresh } satisfies RootContext} />
    {notice && <SecurityNotice notice={notice} onSeen={async () => { await action("acknowledge_security_notice", {}); await refresh(); }} />}
    <CommandPalette current={current} signOut={signOut} />
  </>;
}

/** "/" opens the first workspace, or the chooser when there is none. */
export function HomeRedirect() {
  const { current, languageSwitch, signOut, refresh } = useRoot();
  const first = current.workspaces[0];
  if (first) return <Navigate to={paths.home(first.slug)} replace />;
  return <WorkspaceChooser current={current} languageSwitch={languageSwitch} signOut={signOut} refresh={refresh} />;
}
