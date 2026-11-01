import React from "react";
import { translate } from "@weft/shared";

/** Sign in and sign up. `inviteToken` rides along on sign-up so the new account joins the inviting workspace. */
export function AuthScreen({ api, inviteToken, onSignedIn, languageSwitch }: { api: string; inviteToken: string | null; onSignedIn: () => Promise<void>; languageSwitch: React.ReactNode }) {
  const [mode, setMode] = React.useState<"sign-in" | "sign-up">("sign-up");
  const [error, setError] = React.useState<string | null>(null);
  const [name, setName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");

  async function authenticate(event: React.FormEvent) {
    event.preventDefault(); setError(null);
    const endpoint = mode === "sign-up" ? "sign-up/email" : "sign-in/email";
    const response = await fetch(`${api}/api/auth/${endpoint}`, {
      method: "POST", credentials: "include", headers: { "content-type": "application/json", ...(mode === "sign-up" && inviteToken ? { "x-weft-invite": inviteToken } : {}) },
      body: JSON.stringify(mode === "sign-up" ? { name, email, password } : { email, password }),
    });
    if (!response.ok) { setError(translate("auth.failed")); return; }
    await onSignedIn();
  }

  return <main className="mx-auto my-[10vh] w-full max-w-lg rounded-xl border border-subtle bg-surface-1 p-8 shadow-sm">
    <header className="flex justify-end">{languageSwitch}</header>
    <h1 className="text-28 font-semibold">{translate("app.title")}</h1>
    <p className="text-secondary">{translate("app.welcome")}</p>
    <form onSubmit={authenticate} className="my-6 grid gap-4">
      {mode === "sign-up" && <label className="grid gap-1.5">{translate("auth.name")}<input required value={name} onChange={(event) => setName(event.target.value)} /></label>}
      <label className="grid gap-1.5">{translate("auth.email")}<input required type="email" value={email} onChange={(event) => setEmail(event.target.value)} /></label>
      <label className="grid gap-1.5">{translate("auth.password")}<input required type="password" minLength={8} value={password} onChange={(event) => setPassword(event.target.value)} /></label>
      <button>{translate(mode === "sign-up" ? "auth.signUp" : "auth.signIn")}</button>
    </form>
    <button className="secondary" onClick={() => setMode(mode === "sign-up" ? "sign-in" : "sign-up")}>
      {translate(mode === "sign-up" ? "auth.haveAccount" : "auth.needAccount")}
    </button>
    {error && <p role="alert" className="text-danger-text">{error}</p>}
  </main>;
}
