import React from "react";
import { Navigate, Outlet, useMatch, useNavigate, useOutletContext } from "react-router";
import { translate } from "@weft/shared";
import { action, api } from "../api";
import { useLiveUpdates } from "../live-updates";
import { LanguageSwitch, adoptUserLocale, useLocale } from "../locale";
import { paths } from "../routes";
import { useTheme, themes } from "../theme";
import type { Current, Workspace } from "../types";
import { AuthScreen } from "./auth-screen";

export type RootContext = { current: Current; languageSwitch: React.ReactNode; themeSwitch: React.ReactNode; signOut: () => Promise<void>; refresh: () => Promise<void> };
export const useRoot = () => useOutletContext<RootContext>();

function slugify(value: string) { return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); }

function ThemeSwitch() {
  const [theme, setTheme] = useTheme();
  return <label className="flex items-center gap-1.5">{translate("theme.label")}
    <select value={theme} onChange={(event) => setTheme(event.target.value as (typeof themes)[number])}>
      {themes.map((value) => <option key={value} value={value}>{translate(`theme.${value}`)}</option>)}
    </select></label>;
}

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

  return <main className="mx-auto my-[10vh] w-full max-w-lg rounded-xl border border-subtle bg-surface-1 p-8 shadow-sm">
    <header className="flex items-center justify-between gap-4"><h1 className="text-20 font-semibold">{needsFirstWorkspace ? translate("workspace.firstTitle") : translate("workspace.yourWorkspaces")}</h1>{languageSwitch}<button className="secondary" onClick={() => void signOut()}>{translate("auth.signOut")}</button></header>
    {current.workspaces.map((item) => <p key={item.id}><a href={paths.home(item.slug)}>{item.name}</a></p>)}
    {current.canCreateWorkspace && <form onSubmit={createWorkspace} className="my-6 grid gap-4">
      <label className="grid gap-1.5">{translate("workspace.name")}<input required value={workspaceName} onChange={(event) => {
        const value = event.target.value; setWorkspaceName(value);
        if (!slug || slug === slugify(workspaceName)) setSlug(slugify(value));
      }} /></label>
      <label className="grid gap-1.5">{translate("workspace.slug")}<input required pattern="[a-z0-9]+(-[a-z0-9]+)*" value={slug} onChange={(event) => setSlug(event.target.value)} /></label>
      <button>{translate("workspace.create")}</button>
    </form>}
    {!current.canCreateWorkspace && <p>{translate("workspace.noAccess")}</p>}
    {error && <p role="alert" className="text-danger-text">{error}</p>}
  </main>;
}

/** Top route: loads the signed-in user, shows the auth screen when there is none, and handles invite links. Everything below gets `current` through the outlet context. */
export function RootLayout() {
  useLocale();
  const navigate = useNavigate();
  const [current, setCurrent] = React.useState<Current | null | undefined>(undefined);
  const [inviteError, setInviteError] = React.useState<string | null>(null);
  const inviteToken = useMatch("/invite/:token")?.params.token ?? null;
  useLiveUpdates(Boolean(current), api);

  const refresh = React.useCallback(async () => {
    const response = await fetch(`${api}/api/me`, { credentials: "include" });
    if (!response.ok) { setCurrent(null); return; }
    const data = await response.json() as Current;
    setCurrent(data);
    adoptUserLocale(data.user.locale);
    if (inviteToken) {
      const joined = await action<{ slug: string }>("accept_invite", { token: inviteToken });
      if (joined) navigate(paths.home(joined.slug), { replace: true }); else setInviteError(translate("invite.failed"));
    }
  }, [inviteToken, navigate]);
  React.useEffect(() => { void refresh(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const signOut = React.useCallback(async () => {
    await fetch(`${api}/api/auth/sign-out`, { method: "POST", credentials: "include" });
    setCurrent(null);
  }, []);
  const languageSwitch = <LanguageSwitch signedIn={Boolean(current)} save={async (locale) => (await action("set_my_locale", { locale })) !== null} />;

  if (current === undefined) return null;
  if (current === null) return <AuthScreen api={api} inviteToken={inviteToken} onSignedIn={refresh} languageSwitch={languageSwitch} />;
  if (inviteToken) return <main><p role={inviteError ? "alert" : "status"}>{inviteError ?? translate("invite.joining")}</p></main>;
  return <Outlet context={{ current, languageSwitch, themeSwitch: <ThemeSwitch />, signOut, refresh } satisfies RootContext} />;
}

/** "/" opens the first workspace, or the chooser when there is none. */
export function HomeRedirect() {
  const { current, languageSwitch, signOut, refresh } = useRoot();
  const first = current.workspaces[0];
  if (first) return <Navigate to={paths.home(first.slug)} replace />;
  return <WorkspaceChooser current={current} languageSwitch={languageSwitch} signOut={signOut} refresh={refresh} />;
}
