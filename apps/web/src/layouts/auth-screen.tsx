import React from "react";
import { translate } from "@weft/shared";
import { AuthShell, fieldClass, primaryButton } from "./auth-shell";
import { ThemeSwitch } from "./theme-switch";
import { authClient } from "../auth-client";

/** Sign in and sign up. Sign in is the default (most visits are returning users); an invite link opens on sign-up, and `inviteToken` rides along so the new account joins the inviting workspace. */
export function AuthScreen({ api, inviteToken, onSignedIn, languageSwitch }: { api: string; inviteToken: string | null; onSignedIn: () => Promise<void>; languageSwitch: React.ReactNode }) {
  const oauthSignIn = window.location.pathname === "/oauth/sign-in";
  const [mode, setMode] = React.useState<"sign-in" | "sign-up">(inviteToken ? "sign-up" : "sign-in");
  const [error, setError] = React.useState<string | null>(null);
  const [name, setName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");

  async function authenticate(event: React.FormEvent) {
    event.preventDefault(); setError(null);
    if (oauthSignIn) {
      const result = mode === "sign-in"
        ? await authClient.signIn.email({ email, password })
        : await authClient.signUp.email({ name, email, password, fetchOptions: { headers: inviteToken ? { "x-weft-invite": inviteToken } : undefined } });
      if (result.error) { setError(translate(mode === "sign-in" ? "auth.signInFailed" : "auth.signUpFailed")); return; }
      const redirect = result.data as unknown as { redirect?: boolean; url?: string };
      if (redirect.redirect && redirect.url) { window.location.assign(redirect.url); return; }
      await onSignedIn();
      return;
    }
    const endpoint = mode === "sign-up" ? "sign-up/email" : "sign-in/email";
    let response: Response;
    try {
      response = await fetch(`${api}/api/auth/${endpoint}`, {
        method: "POST", credentials: "include", headers: { "content-type": "application/json", ...(mode === "sign-up" && inviteToken ? { "x-weft-invite": inviteToken } : {}) },
        body: JSON.stringify(mode === "sign-up" ? { name, email, password } : { email, password }),
      });
    } catch { setError(translate("auth.networkFailed")); return; }
    if (!response.ok) { setError(translate(response.status >= 500 ? "auth.networkFailed" : mode === "sign-in" ? "auth.signInFailed" : "auth.signUpFailed")); return; }
    await onSignedIn();
  }

  return <AuthShell footer={<>{languageSwitch}<ThemeSwitch /></>}>
    <h1 className="text-20 font-semibold leading-tight text-primary">{translate("app.welcome")}
      <span className="block text-tertiary">{translate(mode === "sign-up" ? "auth.createYourAccount" : "auth.welcomeBack")}</span>
    </h1>
    {inviteToken && <p role="status" className="mt-4 rounded-md bg-accent-subtle px-3 py-2 text-13 text-accent-text">{translate("invite.signInToJoin")}</p>}
    <form onSubmit={authenticate} className="mt-8 grid gap-4">
      {mode === "sign-up" && <label className="grid gap-1.5 text-13 font-medium text-secondary">{translate("auth.name")}<input className={fieldClass} required autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} /></label>}
      <label className="grid gap-1.5 text-13 font-medium text-secondary">{translate("auth.email")}<input className={fieldClass} required type="email" autoComplete="email" placeholder={translate("auth.emailPlaceholder")} value={email} onChange={(event) => setEmail(event.target.value)} /></label>
      <label className="grid gap-1.5 text-13 font-medium text-secondary">{translate("auth.password")}<input className={fieldClass} required type="password" minLength={8} autoComplete={mode === "sign-up" ? "new-password" : "current-password"} value={password} onChange={(event) => setPassword(event.target.value)} /></label>
      <button className={primaryButton}>{translate(mode === "sign-up" ? "auth.signUp" : "auth.signIn")}</button>
    </form>
    {error && <p role="alert" className="mt-4 text-13 text-danger-text">{error}</p>}
    {/* The other mode is a full-width secondary button under the form (not small text), so a first-run admin who lands on Sign in finds "Create account". */}
    <div className="mt-6 grid gap-2 border-t border-subtle pt-6 text-center">
      <p className="m-0 text-13 text-secondary">{translate(mode === "sign-up" ? "auth.haveAccountShort" : "auth.needAccountShort")}</p>
      <button type="button" className="h-10 w-full rounded-md border border-strong bg-transparent px-3 text-14 font-medium text-primary hover:bg-layer-transparent-hover" onClick={() => { setError(null); setMode(mode === "sign-up" ? "sign-in" : "sign-up"); }}>
        {translate(mode === "sign-up" ? "auth.signIn" : "auth.signUp")}
      </button>
    </div>
  </AuthShell>;
}
