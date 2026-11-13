import React from "react";
import { translate, type MessageKey } from "@weft/shared";
import { action, api } from "../../api";
import { Note, Row, RowList, SettingsBlock, SettingsHeader } from "./settings-ui";

type EmailPreferences = { email: string; emailVerified: boolean; kinds: string[] };

/** Every notification kind that can be emailed, in the order the page lists them. */
const emailKinds: Array<{ kind: string; label: MessageKey }> = [
  { kind: "assignment", label: "email.kind.assignment" },
  { kind: "mention", label: "email.kind.mention" },
  { kind: "reply", label: "email.kind.reply" },
  { kind: "run_result", label: "email.kind.run_result" },
];

/** The signed-in person's email notifications: whether email is set up here, whether the address is confirmed, and which kinds to send. */
export function AccountNotificationsPage() {
  const [prefs, setPrefs] = React.useState<EmailPreferences | null>(null);
  const [emailEnabled, setEmailEnabled] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const [note, setNote] = React.useState<string | null>(null);
  const [noteError, setNoteError] = React.useState(false);

  React.useEffect(() => {
    void (async () => {
      const config = await fetch(`${api}/api/config`).then((response) => response.ok ? response.json() as Promise<{ emailEnabled?: boolean }> : null).catch(() => null);
      setEmailEnabled(config?.emailEnabled === true);
      const loaded = await action<EmailPreferences>("get_my_email_preferences", {});
      setFailed(loaded === null);
      setPrefs(loaded);
    })();
  }, []);

  async function save(kinds: string[]) {
    const saved = await action<EmailPreferences>("set_my_email_preferences", { kinds });
    setNoteError(saved === null);
    setNote(translate(saved === null ? "email.saveFailed" : "email.saved"));
    if (saved) setPrefs(saved);
  }

  async function sendConfirmation() {
    setNote(null);
    const response = await fetch(`${api}/api/auth/send-verification-email`, {
      method: "POST", credentials: "include", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: prefs?.email, callbackURL: window.location.origin }),
    }).catch(() => null);
    setNoteError(!response?.ok);
    setNote(translate(response?.ok ? "email.confirmationSent" : "email.saveFailed"));
  }

  if (!prefs) return <main className="mx-auto w-full max-w-[900px]">
    <SettingsHeader title={translate("email.title")} description={translate("email.description")} />
    <Note note={failed ? translate("email.loadFailed") : null} error />
  </main>;

  return <main className="mx-auto w-full max-w-[900px]">
    <SettingsHeader title={translate("email.title")} description={translate("email.description")} />
    {!emailEnabled && <p role="status" className="mb-6 rounded-md bg-layer-2 px-3 py-2 text-13 text-secondary">{translate("email.off")}</p>}
    <SettingsBlock>
      <RowList>
        <Row><span className="flex-1">{translate("email.sendingTo")}: <strong className="font-medium">{prefs.email}</strong></span>
          {prefs.emailVerified
            ? <span className="text-13 text-secondary">{translate("email.confirmed")}</span>
            : <span className="text-13 text-secondary">{translate("email.unconfirmed")}</span>}
          {!prefs.emailVerified && emailEnabled && <button type="button" className="h-8 rounded-md border border-strong px-3 text-13 font-medium text-primary hover:bg-layer-transparent-hover" onClick={() => void sendConfirmation()}>{translate("email.sendConfirmation")}</button>}
        </Row>
      </RowList>
    </SettingsBlock>
    <SettingsBlock title={translate("email.kindsLabel")}>
      <fieldset className="m-0 grid gap-2 border-0 p-0">
        <legend className="sr-only">{translate("email.kindsLabel")}</legend>
        {emailKinds.map(({ kind, label }) => <label key={kind} className="flex items-center gap-2 text-14 text-primary">
          <input type="checkbox" checked={prefs.kinds.includes(kind)} onChange={(event) => void save(event.target.checked ? [...prefs.kinds, kind] : prefs.kinds.filter((value) => value !== kind))} />
          {translate(label)}
        </label>)}
      </fieldset>
    </SettingsBlock>
    <SettingsBlock>
      <div className="grid gap-1">
        <div><button type="button" className="h-9 rounded-md border border-strong px-3 text-14 font-medium text-primary hover:bg-layer-transparent-hover disabled:opacity-50" disabled={prefs.kinds.length === 0} onClick={() => void save([])}>{translate("email.turnOffAll")}</button></div>
        <p className="m-0 text-13 text-secondary">{translate("email.turnOffHelp")}</p>
      </div>
      <Note note={note} error={noteError} />
    </SettingsBlock>
  </main>;
}
