import React from "react";
import { translate } from "@weft/shared";
import { AuthShell, fieldClass, primaryButton } from "../layouts/auth-shell";
import { paths } from "../routes";

/** The page a reset link opens. The API redirects here with `?token=` (or `?error=INVALID_TOKEN` when the link is no good). Public: it shows before sign-in. */
export function ResetPasswordScreen({ api, languageSwitch, minPasswordLength }: { api: string; languageSwitch: React.ReactNode; minPasswordLength: number }) {
  const params = new URLSearchParams(window.location.search);
  const token = params.get("token");
  const [password, setPassword] = React.useState("");
  const [confirm, setConfirm] = React.useState("");
  const [state, setState] = React.useState<"form" | "done" | "invalid">(token ? "form" : "invalid");
  const [error, setError] = React.useState<string | null>(null);
  const mismatch = confirm !== "" && confirm !== password;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (mismatch || !token) return;
    setError(null);
    try {
      const response = await fetch(`${api}/api/auth/reset-password`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ newPassword: password, token }) });
      if (response.ok) { setState("done"); return; }
      // An expired or already used link lands here too; a server failure is a different message.
      setError(translate(response.status >= 500 ? "auth.networkFailed" : "auth.resetLinkInvalid"));
      if (response.status < 500) setState("invalid");
    } catch {
      setError(translate("auth.networkFailed"));
    }
  }

  return <AuthShell footer={<>{languageSwitch}</>}>
    <h1 className="text-balance text-20 font-semibold leading-tight text-primary">{translate("auth.resetTitle")}</h1>
    {state === "invalid" && <p role="alert" className="mt-4 text-13 text-danger-text">{translate("auth.resetLinkInvalid")}</p>}
    {state === "done" && <p role="status" className="mt-4 text-13 text-secondary">{translate("auth.resetDone")}</p>}
    {state === "form" && <form onSubmit={submit} className="mt-8 grid gap-4">
      <label className="grid gap-1.5 text-13 font-medium text-secondary">{translate("auth.newPassword")}<input className={fieldClass} required type="password" minLength={minPasswordLength} autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
      <label className="grid gap-1.5 text-13 font-medium text-secondary">{translate("auth.confirmPassword")}<input className={`${fieldClass} ${mismatch ? "border-danger-strong" : ""}`} required type="password" minLength={minPasswordLength} autoComplete="new-password" aria-invalid={mismatch || undefined} value={confirm} onChange={(event) => setConfirm(event.target.value)} /></label>
      {mismatch && <p role="status" className="-mt-2 text-13 text-danger-text">{translate("auth.passwordMismatch")}</p>}
      <button className={primaryButton} disabled={mismatch}>{translate("auth.resetSubmit")}</button>
      {error && <p role="alert" className="text-13 text-danger-text">{error}</p>}
    </form>}
    <div className="mt-6 border-t border-subtle pt-6 text-center">
      <a href={paths.home("")} className="text-14 font-medium text-accent-text">{translate("auth.backToSignIn")}</a>
    </div>
  </AuthShell>;
}
