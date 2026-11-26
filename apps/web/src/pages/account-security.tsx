import { Button } from "@/ui/button";
import React from "react";
import { formatDate, translate } from "@weft/shared";
import { action, api } from "../api";
import { OnboardingShell, fieldClass, primaryButton } from "../layouts/auth-shell";
import { securityNoticeText } from "../security-notice";
import { Dialog } from "../dialog";
import { Note, Row, RowList, SettingsBlock, SettingsHeader } from "./settings/settings-ui";

import { Input } from "@/ui/input";
type SessionRow = { id: string; device: string; createdAt: string; lastSeenAt: string; current: boolean };

/** Shown instead of the app while an Admin's forced reset is pending: the person chooses a new password before anything else. */
export function ForcedPasswordReset({ notice, languageSwitch, signOut, onDone, minPasswordLength }: { notice: string | null; languageSwitch: React.ReactNode; signOut: () => Promise<void>; onDone: () => Promise<void>; minPasswordLength: number }) {
  const [currentPassword, setCurrentPassword] = React.useState("");
  const [newPassword, setNewPassword] = React.useState("");
  const [confirmPassword, setConfirmPassword] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    if (newPassword.length < minPasswordLength) { setError(translate("account.passwordTooShort").replace("{min}", String(minPasswordLength))); return; }
    if (newPassword !== confirmPassword) { setError(translate("auth.passwordMismatch")); return; }
    setBusy(true);
    const response = await fetch(`${api}/api/account/change-password`, {
      method: "POST", credentials: "include", headers: { "content-type": "application/json" },
      body: JSON.stringify({ currentPassword, newPassword }),
    }).catch(() => null);
    setBusy(false);
    // The sign-in library's own English message is never shown; every failed save gets the translated one.
    if (!response?.ok) { setError(translate(response && response.status < 500 ? "account.resetFailed" : "auth.networkFailed")); return; }
    await onDone();
  }

  return <OnboardingShell action={<Button type="button" className="!h-auto !bg-transparent !p-0 font-semibold !text-foreground hover:underline" onClick={() => void signOut()}>{translate("auth.signOut")}</Button>}>
    <h1 className="text-xl font-semibold">{translate("account.resetTitle")}</h1>
    <p className="text-sm text-muted-foreground">{notice ? securityNoticeText(notice) : translate("account.resetWhy")}</p>
    <form onSubmit={submit} className="grid gap-4">
      <label className="grid gap-1.5 text-sm font-medium text-muted-foreground">{translate("account.currentPassword")}<Input className={fieldClass} type="password" autoComplete="current-password" required value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} /></label>
      <label className="grid gap-1.5 text-sm font-medium text-muted-foreground">{translate("account.newPassword")}<Input className={fieldClass} type="password" autoComplete="new-password" required minLength={minPasswordLength} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} /></label>
      <label className="grid gap-1.5 text-sm font-medium text-muted-foreground">{translate("auth.confirmPassword")}<Input className={fieldClass} type="password" autoComplete="new-password" required minLength={minPasswordLength} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} /></label>
      <p className="text-sm text-muted-foreground">{translate("account.resetHelp")}</p>
      <Button className={primaryButton} disabled={busy}>{translate("account.resetSave")}</Button>
    </form>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <div className="flex items-center gap-4 pt-2 text-sm text-muted-foreground">{languageSwitch}</div>
  </OnboardingShell>;
}

/** The one-time notice after an Admin signed the person out or asked for a reset. Closing it counts as seen. */
export function SecurityNotice({ notice, onSeen }: { notice: string; onSeen: () => Promise<void> }) {
  return <Dialog title={translate("account.noticeTitle")} onClose={() => void onSeen()}>
    <p className="text-sm text-foreground">{securityNoticeText(notice)}</p>
    <div className="flex justify-end"><Button type="button" className={primaryButton} onClick={() => void onSeen()}>{translate("account.noticeOk")}</Button></div>
  </Dialog>;
}

/** Summarises a browser from its user agent, in words a person recognises. */
export function SessionsPage() {
  const [sessions, setSessions] = React.useState<SessionRow[] | null>(null);
  const [note, setNote] = React.useState<string | null>(null);
  const [failed, setFailed] = React.useState(false);
  const load = React.useCallback(async () => setSessions(await action<SessionRow[]>("list_my_sessions", {}) ?? []), []);
  React.useEffect(() => { void load(); }, [load]);

  const revoke = async (row: SessionRow) => {
    const result = await action<{ id: string; current: boolean }>("revoke_my_session", { sessionId: row.id });
    if (result === null) { setFailed(true); setNote(translate("account.sessionsFailed")); return; }
    // Signing out the device you are using ends this page's session too.
    if (result.current) { window.location.assign("/"); return; }
    setFailed(false); setNote(translate("account.sessionEnded")); await load();
  };
  const signOutEverywhere = async () => {
    if (!window.confirm(translate("account.signOutEverywhereConfirm"))) return;
    const result = await action("sign_out_everywhere", {});
    if (result === null) { setFailed(true); setNote(translate("account.sessionsFailed")); return; }
    window.location.assign("/");
  };

  return <main className="mx-auto w-full max-w-[900px] px-4">
    <SettingsHeader title={translate("account.sessionsTitle")} description={translate("account.sessionsDesc")}>
      <Button type="button" className="secondary hover:!text-destructive" onClick={() => void signOutEverywhere()}>{translate("account.signOutEverywhere")}</Button>
    </SettingsHeader>
    <SettingsBlock>
      {sessions === null ? null : sessions.length === 0 ? <p className="text-muted-foreground">{translate("account.sessionsNone")}</p> : <RowList>{sessions.map((row) => <Row key={row.id}>
        <span className="grid min-w-0 flex-1"><span className="font-medium">{row.device}{row.current && <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{translate("account.thisDevice")}</span>}</span>
          <span className="text-sm text-muted-foreground">{translate("account.signedInAt")} {formatDate(row.createdAt)} · {translate("account.lastSeen")} {formatDate(row.lastSeenAt)}</span></span>
        <Button type="button" className="secondary hover:!text-destructive" onClick={() => void revoke(row)}>{row.current ? translate("account.signOutThis") : translate("account.signOutDevice")}</Button>
      </Row>)}</RowList>}
      <Note note={note} error={failed} />
    </SettingsBlock>
  </main>;
}
