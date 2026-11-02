import React from "react";
import { translate } from "@weft/shared";
import { AuthShell, fieldClass, primaryButton } from "./auth-shell";
import { ThemeSwitch } from "./theme-switch";
import { authClient } from "../auth-client";

/** Sign in and sign up. `inviteToken` rides along on sign-up so the new account joins the inviting workspace. */
export function AuthScreen({ api, inviteToken, onSignedIn, languageSwitch }: { api: string; inviteToken: string | null; onSignedIn: () => Promise<void>; languageSwitch: React.ReactNode }) {
  const oauthSignIn = window.location.pathname === "/oauth/sign-in";
  const [mode, setMode] = React.useState<"sign-in" | "sign-up">(oauthSignIn ? "sign-in" : "sign-up");
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
      if (result.error) { setError(translate("auth.failed")); return; }
      const redirect = result.data as unknown as { redirect?: boolean; url?: string };
      if (redirect.redirect && redirect.url) { window.location.assign(redirect.url); return; }
      await onSignedIn();
      return;
    }
    const endpoint = mode === "sign-up" ? "sign-up/email" : "sign-in/email";
    const response = await fetch(`${api}/api/auth/${endpoint}`, {
      method: "POST", credentials: "include", headers: { "content-type": "application/json", ...(mode === "sign-up" && inviteToken ? { "x-weft-invite": inviteToken } : {}) },
      body: JSON.stringify(mode === "sign-up" ? { name, email, password } : { email, password }),
    });
    if (!response.ok) { setError(translate("auth.failed")); return; }
    await onSignedIn();
  }

  const action = <div className="flex flex-col items-end text-center text-13 font-medium text-tertiary sm:flex-row sm:items-center sm:gap-2">
    <span>{translate(mode === "sign-up" ? "auth.haveAccountShort" : "auth.needAccountShort")}</span>
    <button type="button" className="!h-auto !bg-transparent !p-0 font-semibold !text-accent-text hover:underline" onClick={() => { setError(null); setMode(mode === "sign-up" ? "sign-in" : "sign-up"); }}>
      {translate(mode === "sign-up" ? "auth.signIn" : "auth.signUp")}
    </button>
  </div>;

  return <AuthShell action={action} footer={<>{languageSwitch}<ThemeSwitch /></>}>
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
  </AuthShell>;
}
