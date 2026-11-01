import React from "react";
import { Navigate, Outlet, useMatch, useNavigate, useOutletContext } from "react-router";
import { translate } from "@weft/shared";
import { action, api } from "../api";
import { useLiveUpdates } from "../live-updates";
import { LanguageSwitch, adoptUserLocale, useLocale } from "../locale";
import { paths } from "../routes";
import { CreateWorkspaceForm } from "../shell/create-workspace-form";
import type { Current } from "../types";
import { AuthScreen } from "./auth-screen";

export type RootContext = { current: Current; languageSwitch: React.ReactNode; signOut: () => Promise<void>; refresh: () => Promise<void> };
export const useRoot = () => useOutletContext<RootContext>();

/** Workspace chooser and first-workspace form: shown at "/" when no workspace is open, and for an unknown workspace slug. */
export function WorkspaceChooser({ current, languageSwitch, signOut, refresh }: Pick<RootContext, "current" | "languageSwitch" | "signOut" | "refresh">) {
  const navigate = useNavigate();
  const needsFirstWorkspace = current.workspaces.length === 0;

  return <main className="mx-auto my-[10vh] w-full max-w-lg rounded-xl border border-subtle bg-surface-1 p-8 shadow-sm">
    <header className="flex items-center justify-between gap-4"><h1 className="text-20 font-semibold">{needsFirstWorkspace ? translate("workspace.firstTitle") : translate("workspace.yourWorkspaces")}</h1>{languageSwitch}<button className="secondary" onClick={() => void signOut()}>{translate("auth.signOut")}</button></header>
    {current.workspaces.map((item) => <p key={item.id}><a href={paths.home(item.slug)}>{item.name}</a></p>)}
    {current.canCreateWorkspace && <CreateWorkspaceForm onCreated={async (workspace) => { await refresh(); navigate(paths.home(workspace.slug)); }} />}
    {!current.canCreateWorkspace && <p>{translate("workspace.noAccess")}</p>}
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
  return <Outlet context={{ current, languageSwitch, signOut, refresh } satisfies RootContext} />;
}

/** "/" opens the first workspace, or the chooser when there is none. */
export function HomeRedirect() {
  const { current, languageSwitch, signOut, refresh } = useRoot();
  const first = current.workspaces[0];
  if (first) return <Navigate to={paths.home(first.slug)} replace />;
  return <WorkspaceChooser current={current} languageSwitch={languageSwitch} signOut={signOut} refresh={refresh} />;
}
