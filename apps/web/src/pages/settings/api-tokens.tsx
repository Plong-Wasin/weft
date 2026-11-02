import React from "react";
import { formatDate, translate } from "@weft/shared";
import { action } from "../../api";
import { hasValidTokenExpiry } from "../../token-expiry";
import { Note, Row, RowList, SettingsBlock, SettingsHeader } from "./settings-ui";

type ApiToken = {
  id: string; name: string; prefix: string; description: string | null; createdAt: string;
  expiresAt: string | null; lastUsedAt: string | null; status: "active" | "expired" | "revoked";
};
type CreatedToken = { id: string; name: string; token: string };
type Preset = "week" | "month" | "quarter" | "year" | "custom";

function dateValue(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function afterPreset(preset: Preset) {
  const date = new Date();
  if (preset === "week") date.setDate(date.getDate() + 7);
  if (preset === "month") date.setMonth(date.getMonth() + 1);
  if (preset === "quarter") date.setMonth(date.getMonth() + 3);
  if (preset === "year") date.setFullYear(date.getFullYear() + 1);
  return dateValue(date);
}

function todayTomorrow() {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  return dateValue(date);
}

export function ApiTokensPage() {
  const [tokens, setTokens] = React.useState<ApiToken[]>([]);
  const [loaded, setLoaded] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const [dialog, setDialog] = React.useState(false);
  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [preset, setPreset] = React.useState<Preset>("week");
  const [expiresAt, setExpiresAt] = React.useState(() => afterPreset("week"));
  const [neverExpires, setNeverExpires] = React.useState(false);
  const [secret, setSecret] = React.useState<CreatedToken | null>(null);
  const [note, setNote] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    const result = await action<ApiToken[]>("list_api_tokens", {});
    setFailed(result === null);
    if (result) setTokens(result);
    setLoaded(true);
  }, []);
  React.useEffect(() => { void load(); }, [load]);

  function closeDialog() {
    setDialog(false);
    setSecret(null);
    setName(""); setDescription(""); setPreset("week"); setExpiresAt(afterPreset("week")); setNeverExpires(false);
  }

  async function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!hasValidTokenExpiry(expiresAt, neverExpires)) return;
    const created = await action<CreatedToken>("create_api_token", {
      name: name.trim(), description: description.trim(),
      ...(neverExpires ? {} : { expiresAt }),
    });
    if (!created) { setFailed(true); return; }
    setFailed(false);
    setSecret(created);
    await load();
  }

  async function revoke(token: ApiToken) {
    if (!window.confirm(translate("tokens.revokeConfirm"))) return;
    const result = await action("revoke_api_token", { tokenId: token.id });
    setNote(result ? translate("tokens.revoked") : translate("tokens.failed"));
    if (result) await load();
  }

  return <main className="mx-auto w-full max-w-[900px]">
    <SettingsHeader title={translate("tokens.title")} description={translate("tokens.description")}>
      <button type="button" onClick={() => { setDialog(true); setNote(null); }}>{translate("tokens.add")}</button>
    </SettingsHeader>
    <SettingsBlock>
      {failed && <Note note={translate("tokens.failed")} error />}
      {loaded && tokens.length === 0 && !failed && <p className="text-14 text-secondary">{translate("tokens.empty")}</p>}
      {tokens.length > 0 && <RowList>{tokens.map((token) => <Row key={token.id}>
        <span className="grid min-w-0 flex-1 gap-0.5">
          <span className="font-medium">{token.name}</span>
          {token.description && <span className="text-13 text-secondary">{token.description}</span>}
          <span className="text-12 text-tertiary">{token.prefix} · {translate("tokens.created")} {formatDate(token.createdAt)} · {translate("tokens.expiry")} {token.expiresAt ? formatDate(token.expiresAt) : translate("tokens.never")}</span>
          <span className="text-12 text-tertiary">{translate("tokens.lastUsed")} {token.lastUsedAt ? formatDate(token.lastUsedAt) : translate("tokens.notUsed")}</span>
        </span>
        <span className={`rounded-full px-2 py-0.5 text-12 ${token.status === "active" ? "bg-accent-subtle text-accent-text" : "bg-layer-2 text-secondary"}`}>{translate(`tokens.status.${token.status}`)}</span>
        {token.status === "active" && <button type="button" className="secondary" onClick={() => void revoke(token)}>{translate("tokens.revoke")}</button>}
      </Row>)}</RowList>}
    </SettingsBlock>
    <Note note={note} />
    {dialog && <div className="fixed inset-0 z-50 grid place-items-center bg-backdrop p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) closeDialog(); }}>
      <section role="dialog" aria-modal="true" aria-labelledby="token-dialog-title" className="grid w-full max-w-lg gap-4 rounded-xl border border-subtle bg-surface-1 p-5 shadow-xl">
        <header className="flex items-start justify-between gap-3"><div><h2 id="token-dialog-title" className="text-18 font-semibold">{secret ? translate("tokens.createdTitle") : translate("tokens.add")}</h2>
          <p className="mt-1 text-13 text-secondary">{secret ? translate("tokens.secretOnce") : translate("tokens.dialogDescription")}</p></div>
          <button type="button" className="secondary" onClick={closeDialog}>{translate("settings.cancel")}</button></header>
        {secret ? <div className="grid gap-2">
          <label>{translate("tokens.secret")}<input readOnly value={secret.token} className="font-mono" /></label>
          <div className="flex items-center gap-2"><button type="button" onClick={async () => { await navigator.clipboard.writeText(secret.token); setNote(translate("tokens.copied")); }}>{translate("tokens.copy")}</button>
            <button type="button" className="secondary" onClick={closeDialog}>{translate("settings.cancel")}</button></div>
        </div> : <form className="grid gap-3" onSubmit={(event) => void create(event)}>
          <label>{translate("tokens.name")}<input required maxLength={100} autoFocus value={name} onChange={(event) => setName(event.target.value)} /></label>
          <label>{translate("tokens.fieldDescription")}<textarea maxLength={500} value={description} onChange={(event) => setDescription(event.target.value)} /></label>
          <label>{translate("tokens.expiry")}<select disabled={neverExpires} value={preset} onChange={(event) => {
            const next = event.target.value as Preset; setPreset(next);
            if (next !== "custom") setExpiresAt(afterPreset(next));
          }}>
            <option value="week">{translate("tokens.oneWeek")}</option><option value="month">{translate("tokens.oneMonth")}</option>
            <option value="quarter">{translate("tokens.threeMonths")}</option><option value="year">{translate("tokens.oneYear")}</option><option value="custom">{translate("tokens.custom")}</option>
          </select></label>
          {preset === "custom" && <label>{translate("tokens.customDate")}<input required={!neverExpires} type="date" min={todayTomorrow()} value={expiresAt} disabled={neverExpires} onChange={(event) => setExpiresAt(event.target.value)} /></label>}
          <label className="flex items-center gap-2"><input type="checkbox" checked={neverExpires} onChange={(event) => setNeverExpires(event.target.checked)} />{translate("tokens.neverExpires")}</label>
          <div className="flex justify-end gap-2"><button type="button" className="secondary" onClick={closeDialog}>{translate("settings.cancel")}</button><button type="submit" disabled={!hasValidTokenExpiry(expiresAt, neverExpires)}>{translate("tokens.create")}</button></div>
          {failed && <Note note={translate("tokens.failed")} error />}
        </form>}
      </section>
    </div>}
  </main>;
}
