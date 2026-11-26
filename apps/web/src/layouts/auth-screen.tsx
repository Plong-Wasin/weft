import { Button } from "@/ui/button";
import React from "react";
import { Eye, EyeOff } from "lucide-react";
import { translate, translateDynamic } from "@weft/shared";
import { limitMessage } from "../auth-limit-message";
import { passwordFieldMinLength } from "../auth-password-rule";
import { AuthShell, fieldClass, primaryButton } from "./auth-shell";
import { ThemeSwitch } from "./theme-switch";
import { authClient } from "../auth-client";

import { Input } from "@/ui/input";
/** Sign in and sign up. Sign in is the default (most visits are returning users); an invite link opens on sign-up, and `inviteToken` rides along so the new account joins the inviting workspace. */
export function AuthScreen({ api, inviteToken, onSignedIn, languageSwitch, minPasswordLength = 10, emailEnabled = false, contextualNotice }: { api: string; inviteToken: string | null; onSignedIn: () => Promise<void>; languageSwitch: React.ReactNode; minPasswordLength?: number; emailEnabled?: boolean; contextualNotice?: string }) {
  const oauthSignIn = window.location.pathname === "/oauth/sign-in";
  const [mode, setMode] = React.useState<"sign-in" | "sign-up" | "forgot">(inviteToken ? "sign-up" : "sign-in");
  const callbackError = new URLSearchParams(window.location.search).get("error");
  const [error, setError] = React.useState<string | null>(() => {
    if (callbackError === "MICROSOFT_WRONG_TENANT") return translate("auth.microsoftWrongTenant");
    if (callbackError === "MICROSOFT_DOMAIN_NOT_ALLOWED") return translate("auth.microsoftDomainNotAllowed");
    if (callbackError === "WEFT_INVITE_REQUIRED") return translate("auth.microsoftInviteRequired");
    if (callbackError === "account_not_linked") return translate("auth.microsoftLinkRequired");
    return callbackError ? translate("auth.microsoftFailed") : null;
  });
  const [passwordIssue, setPasswordIssue] = React.useState<string | null>(null);
  const [name, setName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [confirmPassword, setConfirmPassword] = React.useState("");
  const [showPassword, setShowPassword] = React.useState(false);
  const [pending, setPending] = React.useState(false);
  const pendingRef = React.useRef(false);
  const [authSettings, setAuthSettings] = React.useState<{ microsoftSignInEnabled: boolean; passwordSignInEnabled: boolean } | null>(null);
  const mismatch = mode === "sign-up" && confirmPassword !== "" && confirmPassword !== password;

  React.useEffect(() => {
    let active = true;
    void fetch(`${api}/api/auth/settings`, { credentials: "include" }).then(async (response) => {
      if (!response.ok) throw new Error("Auth settings unavailable");
      return response.json() as Promise<{ microsoftSignInEnabled: boolean; passwordSignInEnabled: boolean }>;
    }).then((settings) => { if (active) setAuthSettings(settings); }).catch(() => { if (active) setAuthSettings({ microsoftSignInEnabled: false, passwordSignInEnabled: true }); });
    return () => { active = false; };
  }, [api]);

  async function signInWithMicrosoft() {
    setError(null);
    const oauthQuery = new URLSearchParams(window.location.search).get("oauth_query");
    const callbackURL = oauthSignIn && oauthQuery
      ? `${api}/api/auth/oauth2/authorize?${new URLSearchParams({ oauth_query: oauthQuery })}`
      : window.location.href;
    const result = await authClient.signIn.social({
      provider: "microsoft-entra-id",
      callbackURL,
      fetchOptions: { headers: inviteToken ? { "x-weft-invite": inviteToken } : undefined },
    });
    if (result.error) setError(translate("auth.microsoftFailed"));
    else if (result.data?.url) window.location.assign(result.data.url);
    else setError(translate("auth.microsoftFailed"));
  }

  async function authenticate(event: React.FormEvent) {
    event.preventDefault(); setError(null); setPasswordIssue(null);
    if (pendingRef.current || mismatch) return; // the ref closes the same-render double-submit window
    pendingRef.current = true;
    setPending(true);
    try {
      if (oauthSignIn) {
        const result = mode === "sign-in"
          ? await authClient.signIn.email({ email, password })
          : await authClient.signUp.email({ name, email, password, fetchOptions: { headers: inviteToken ? { "x-weft-invite": inviteToken } : undefined } });
        if (result.error) {
          const limit = limitMessage(result.error.status, result.error as { code?: unknown; retryAfterSeconds?: unknown });
          if (limit) { setError(limit); return; }
          const code = (result.error as { code?: string }).code ?? "";
          const localized = translateDynamic(`auth.passwordError.${code}`);
          if (mode === "sign-up" && localized) setPasswordIssue(localized);
          else setError(translate(mode === "sign-in" ? "auth.signInFailed" : "auth.signUpFailed"));
          return;
        }
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
      if (!response.ok) {
        let code = "";
        let body: { code?: string; message?: string; retryAfterSeconds?: number } | null = null;
        try { body = await response.json() as { code?: string; message?: string; retryAfterSeconds?: number }; code = body.code ?? body.message ?? ""; } catch { /* use the generic message */ }
        const limit = limitMessage(response.status, body, response.headers.get("retry-after"));
        if (limit) { setError(limit); return; }
        const key = `auth.passwordError.${code}`;
        const localized = translateDynamic(key);
        if (mode === "sign-up" && localized) setPasswordIssue(localized);
        else setError(translate(response.status >= 500 ? "auth.networkFailed" : mode === "sign-in" ? "auth.signInFailed" : "auth.signUpFailed"));
        return;
      }
      await onSignedIn();
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  if (mode === "forgot") return <ForgotPasswordForm api={api} emailEnabled={emailEnabled} languageSwitch={languageSwitch} onBack={() => setMode("sign-in")} />;

  return <AuthShell footer={<>{languageSwitch}<ThemeSwitch /></>}>
    <h1 className="text-balance text-xl font-semibold leading-tight text-foreground">{translate("app.welcome")}
      <span className="block text-muted-foreground">{translate(mode === "sign-up" ? "auth.createYourAccount" : "auth.welcomeBack")}</span>
    </h1>
    {contextualNotice && <p role="note" className="mt-4 rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">{contextualNotice}</p>}
    {inviteToken && <p role="status" className="mt-4 rounded-md bg-accent px-3 py-2 text-sm text-foreground">{translate("invite.signInToJoin")}</p>}
    {authSettings === null ? <p role="status" className="mt-8 text-sm text-muted-foreground">{translate("auth.loading")}</p> : <>
    {authSettings.microsoftSignInEnabled && <div className="mt-8 grid gap-2">
      <Button variant="ghost" type="button" className="w-full rounded-md border border-border bg-transparent text-sm font-medium text-foreground hover:bg-accent" onClick={() => void signInWithMicrosoft()}>{translate("auth.microsoftButton")}</Button>
      <p className="m-0 text-xs text-muted-foreground">{translate("auth.microsoftHelp")}</p>
    </div>}
    {authSettings.passwordSignInEnabled && <form onSubmit={authenticate} aria-busy={pending} className={`${authSettings.microsoftSignInEnabled ? "mt-5 border-t border-border pt-5" : "mt-8"} grid gap-4`}>
      {mode === "sign-up" && <label className="grid gap-1.5 text-sm font-medium text-muted-foreground">{translate("auth.name")}<Input className={fieldClass} required autoComplete="name" placeholder={translate("auth.namePlaceholder")} value={name} onChange={(event) => setName(event.target.value)} /></label>}
      <label className="grid gap-1.5 text-sm font-medium text-muted-foreground">{translate("auth.email")}<Input className={fieldClass} required type="email" autoComplete="email" placeholder={translate("auth.emailPlaceholder")} value={email} onChange={(event) => setEmail(event.target.value)} /></label>
      <PasswordField label={translate("auth.password")} value={password} onChange={setPassword} visible={showPassword} onToggle={() => setShowPassword(!showPassword)} autoComplete={mode === "sign-up" ? "new-password" : "current-password"} minLength={passwordFieldMinLength(mode, minPasswordLength)} hint={mode === "sign-up" ? translate("auth.passwordHint").replace("{min}", String(minPasswordLength)) : undefined} />
      {passwordIssue && <p role="alert" className="-mt-3 text-sm text-destructive">{passwordIssue}</p>}
      {mode === "sign-up" && <PasswordField label={translate("auth.confirmPassword")} value={confirmPassword} onChange={setConfirmPassword} visible={showPassword} onToggle={() => setShowPassword(!showPassword)} autoComplete="new-password" invalid={mismatch} describedBy="password-mismatch" />}
      {mismatch && <p id="password-mismatch" role="status" className="-mt-2 text-sm text-destructive">{translate("auth.passwordMismatch")}</p>}
      {mode === "sign-in" && <Button type="button" disabled={pending} className="-mt-2 justify-self-end text-sm font-medium text-foreground hover:underline" onClick={() => { if (pendingRef.current) return; setError(null); setMode("forgot"); }}>{translate("auth.forgotPassword")}</Button>}
      <Button disabled={pending} className={primaryButton}>{translate(mode === "sign-up" ? "auth.signUp" : "auth.signIn")}</Button>
    </form>}
    {error && <p role="alert" className="mt-4 text-sm text-destructive">{error}</p>}
    {/* The other mode is a full-width secondary button under the form (not small text), so a first-run admin who lands on Sign in finds "Create account". */}
    {authSettings.passwordSignInEnabled && <div className="mt-6 grid gap-2 border-t border-border pt-6 text-center">
      <p className="m-0 text-sm text-muted-foreground">{translate(mode === "sign-up" ? "auth.haveAccountShort" : "auth.needAccountShort")}</p>
      <Button variant="ghost" type="button" disabled={pending} className="w-full rounded-md border border-border bg-transparent text-sm font-medium text-foreground hover:bg-accent" onClick={() => { if (pendingRef.current) return; setError(null); setConfirmPassword(""); setShowPassword(false); setMode(mode === "sign-up" ? "sign-in" : "sign-up"); }}>
        {translate(mode === "sign-up" ? "auth.signIn" : "auth.signUp")}
      </Button>
    </div>}
    {!authSettings.microsoftSignInEnabled && !authSettings.passwordSignInEnabled && <p role="alert" className="mt-6 text-sm text-destructive">{translate("auth.noSignInMethods")}</p>}
    </>}
  </AuthShell>;
}

/** A password input. With `onToggle` an eye button sits inside the field and shows or hides the text; on sign-up that one button reveals both fields. The button stays outside the <label> so it does not leak into the input's accessible name. */
function PasswordField({ label, value, onChange, visible, onToggle, autoComplete, invalid, describedBy, hint, minLength = 1 }: { label: string; hint?: string; value: string; onChange: (value: string) => void; visible: boolean; onToggle?: () => void; autoComplete: string; invalid?: boolean; describedBy?: string; minLength?: number }) {
  const id = React.useId();
  const Icon = visible ? EyeOff : Eye;
  return <div className="grid gap-1.5">
    <label htmlFor={id} className="text-sm font-medium text-muted-foreground">{label}</label>
    <div className="relative">
      <Input id={id} className={`${fieldClass} ${onToggle ? "pr-10" : ""} ${invalid ? "border-destructive" : ""}`} required type={visible ? "text" : "password"} minLength={minLength} maxLength={256} autoComplete={autoComplete} aria-invalid={invalid || undefined} aria-describedby={[invalid ? describedBy : null, hint ? `${id}-hint` : null].filter(Boolean).join(" ") || undefined} value={value} onChange={(event) => onChange(event.target.value)} />
      {onToggle && <Button type="button" aria-label={translate(visible ? "auth.hidePassword" : "auth.showPassword")} title={translate(visible ? "auth.hidePassword" : "auth.showPassword")} aria-pressed={visible} onClick={onToggle} className="absolute right-1 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">
        <Icon size={16} aria-hidden />
      </Button>}
    </div>
    {hint && <p id={`${id}-hint`} className="m-0 text-xs text-muted-foreground">{hint}</p>}
  </div>;
}

/** Asks for an email and sends a reset link when email is set up. The answer is the same whether or not the address has an account. */
function ForgotPasswordForm({ api, emailEnabled, languageSwitch, onBack }: { api: string; emailEnabled: boolean; languageSwitch: React.ReactNode; onBack: () => void }) {
  const [email, setEmail] = React.useState("");
  const [sent, setSent] = React.useState(false);
  const [pending, setPending] = React.useState(false);
  const pendingRef = React.useRef(false);
  const [error, setError] = React.useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault(); setError(null);
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    try {
      const response = await fetch(`${api}/api/auth/request-password-reset`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, redirectTo: `${window.location.origin}/reset-password` }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { code?: unknown; retryAfterSeconds?: unknown } | null;
        setError(limitMessage(response.status, body, response.headers.get("retry-after")) ?? translate("auth.networkFailed"));
        return;
      }
      setSent(true);
    } catch { setError(translate("auth.networkFailed")); }
    finally { pendingRef.current = false; setPending(false); }
  }

  return <AuthShell footer={<>{languageSwitch}<ThemeSwitch /></>}>
    <h1 className="text-balance text-xl font-semibold leading-tight text-foreground">{translate("auth.forgotTitle")}</h1>
    {!emailEnabled
      ? <p role="status" className="mt-4 text-sm text-muted-foreground">{translate("auth.forgotEmailOff")}</p>
      : sent
        ? <p role="status" className="mt-4 text-sm text-muted-foreground">{translate("auth.forgotSent")}</p>
        : <>
          <p className="mt-4 text-sm text-muted-foreground">{translate("auth.forgotHelp")}</p>
          <form onSubmit={submit} aria-busy={pending} className="mt-6 grid gap-4">
            <label className="grid gap-1.5 text-sm font-medium text-muted-foreground">{translate("auth.email")}<Input className={fieldClass} required type="email" autoComplete="email" placeholder={translate("auth.emailPlaceholder")} value={email} onChange={(event) => setEmail(event.target.value)} /></label>
            <Button disabled={pending} className={primaryButton}>{translate("auth.forgotSubmit")}</Button>
          </form>
          {error && <p role="alert" className="mt-4 text-sm text-destructive">{error}</p>}
        </>}
    <div className="mt-6 grid gap-2 border-t border-border pt-6 text-center">
      <Button variant="ghost" type="button" disabled={pending} className="w-full rounded-md border border-border bg-transparent text-sm font-medium text-foreground hover:bg-accent" onClick={() => { if (!pendingRef.current) onBack(); }}>{translate("auth.backToSignIn")}</Button>
    </div>
  </AuthShell>;
}
