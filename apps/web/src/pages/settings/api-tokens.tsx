import { Button } from "@/ui/button";
import React from "react";
import { Link, Navigate, useParams } from "react-router";
import { copyText } from "../../toast";
import { formatDate, translate } from "@weft/shared";
import { action } from "../../api";
import { useRoot } from "../../layouts/root-layout";
import { paths } from "../../routes";
import { hasValidTokenExpiry } from "../../token-expiry";
import { defaultTokenPreset, presetExpiry, presetName, tokenPresets, type TokenPreset } from "../../token-presets";
import { Note, Row, RowList, SettingsBlock, SettingsHeader } from "./settings-ui";

type ApiToken = {
  id: string; name: string; prefix: string; description: string | null; createdAt: string;
  expiresAt: string | null; lastUsedAt: string | null; revokedAt: string | null; status: "active" | "expired" | "revoked"; kind: "personal" | "daemon";
};
type CredentialPage = { active: ApiToken[]; history: ApiToken[]; historyCount: number; hasMore: boolean };
type CliDevice = { id: string; hostname: string; createdAt: string; lastActivityAt: string; expiresAt: string | null; revokedAt: string | null; status: "active" | "expired" | "revoked"; daemonConnected: boolean };
type DevicePage = { active: CliDevice[]; history: CliDevice[]; historyCount: number; hasMore: boolean };
type CreatedToken = { id: string; name: string; token: string };
type AuthorizedApp = { id: string; name: string; allowedAt: string; lastUsedAt: string | null };

function dateValue(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function todayTomorrow() {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  return dateValue(date);
}

export function ApiTokensPage() {
  const [tokens, setTokens] = React.useState<ApiToken[]>([]);
  const [tokenHistory, setTokenHistory] = React.useState<ApiToken[]>([]);
  const [tokenHistoryCount, setTokenHistoryCount] = React.useState(0);
  const [tokenHistoryHasMore, setTokenHistoryHasMore] = React.useState(false);
  const [devices, setDevices] = React.useState<CliDevice[]>([]);
  const [deviceHistory, setDeviceHistory] = React.useState<CliDevice[]>([]);
  const [deviceHistoryCount, setDeviceHistoryCount] = React.useState(0);
  const [deviceHistoryHasMore, setDeviceHistoryHasMore] = React.useState(false);
  const [apps, setApps] = React.useState<AuthorizedApp[]>([]);
  const [loaded, setLoaded] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const [dialog, setDialog] = React.useState(false);
  const [name, setName] = React.useState(() => presetName(defaultTokenPreset) ?? "");
  const [description, setDescription] = React.useState("");
  const [preset, setPreset] = React.useState<TokenPreset>(defaultTokenPreset);
  const [expiresAt, setExpiresAt] = React.useState(() => presetExpiry());
  const [neverExpires, setNeverExpires] = React.useState(false);
  const { workspaceSlug } = useParams();
  const [secret, setSecret] = React.useState<CreatedToken | null>(null);
  const [note, setNote] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    const [result, devicePage, authorized] = await Promise.all([
      action<CredentialPage>("list_managed_credentials", {}),
      action<DevicePage>("list_cli_devices", {}),
      action<AuthorizedApp[]>("list_authorized_apps", {}),
    ]);
    setFailed(result === null || devicePage === null || authorized === null);
    if (result) {
      setTokens(result.active); setTokenHistory(result.history); setTokenHistoryCount(result.historyCount); setTokenHistoryHasMore(result.hasMore);
    }
    if (devicePage) {
      setDevices(devicePage.active); setDeviceHistory(devicePage.history); setDeviceHistoryCount(devicePage.historyCount); setDeviceHistoryHasMore(devicePage.hasMore);
    }
    if (authorized) setApps(authorized);
    setLoaded(true);
  }, []);
  React.useEffect(() => { void load(); }, [load]);

  function closeDialog() {
    setDialog(false);
    setSecret(null);
    setName(presetName(defaultTokenPreset) ?? ""); setDescription(""); setPreset(defaultTokenPreset); setExpiresAt(presetExpiry()); setNeverExpires(false);
  }

  // A preset fills the name and the expiry. Custom keeps what is already typed and leaves both to the person.
  function choosePreset(next: TokenPreset) {
    setPreset(next);
    const fill = presetName(next);
    if (fill !== null) setName(fill);
    if (next !== "custom") setExpiresAt(presetExpiry());
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
    if (!window.confirm(translate("tokens.revokeConfirm").replace("{name}", token.name))) return;
    const result = await action("revoke_api_token", { tokenId: token.id });
    setNote(result ? translate(token.kind === "daemon" ? "tokens.daemonRevoked" : "tokens.revoked") : translate("tokens.failed"));
    if (result) await load();
  }

  async function revokeDevice(device: CliDevice) {
    if (!window.confirm(translate("devices.revokeConfirm").replace("{hostname}", device.hostname))) return;
    const result = await action("revoke_cli_device", { deviceId: device.id });
    setNote(result ? translate("devices.revoked") : translate("devices.failed"));
    if (result) await load();
  }

  async function loadMoreDevices() {
    const next = await action<DevicePage>("list_cli_devices", { historyOffset: deviceHistory.length });
    if (!next) { setFailed(true); return; }
    setDeviceHistory((current) => [...current, ...next.history]); setDeviceHistoryHasMore(next.hasMore);
  }

  async function loadMoreTokenHistory() {
    const next = await action<CredentialPage>("list_managed_credentials", { historyOffset: tokenHistory.length });
    if (!next) { setFailed(true); return; }
    setTokenHistory((current) => [...current, ...next.history]); setTokenHistoryHasMore(next.hasMore);
  }

  async function revokeHistoricalToken(token: ApiToken) {
    if (!window.confirm(translate("tokens.revokeConfirm").replace("{name}", token.name))) return;
    const result = await action("revoke_api_token", { tokenId: token.id });
    setNote(result ? translate(token.kind === "daemon" ? "tokens.daemonRevoked" : "tokens.revoked") : translate("tokens.failed"));
    if (result) await load();
  }

  async function revokeApp(app: AuthorizedApp) {
    if (!window.confirm(translate("apps.revokeConfirm"))) return;
    const result = await action("revoke_authorized_app", { clientId: app.id });
    setNote(result ? translate("apps.revoked") : translate("tokens.failed"));
    if (result) await load();
  }

  return <main className="mx-auto w-full max-w-[900px]">
    <SettingsHeader title={translate("tokens.title")} description={translate("tokens.description")}>
      <div className="flex flex-wrap items-center gap-3">
        {workspaceSlug && <Link to={paths.workspaceConnectAi(workspaceSlug)} className="text-13 text-accent-text underline">{translate("tokens.connectAiLink")}</Link>}
        <Button type="button" onClick={() => { setDialog(true); setNote(null); }}>{translate("tokens.add")}</Button>
      </div>
    </SettingsHeader>
    <SettingsHeader level={2} title={translate("devices.title")} description={translate("devices.description")} />
    <SettingsBlock>
      {devices.length === 0 && loaded && !failed && <p className="text-14 text-secondary">{translate("devices.empty")}</p>}
      {devices.length > 0 && <RowList>{devices.map((device) => <Row key={device.id}>
        <span className="grid min-w-0 flex-[1_1_15rem] gap-0.5">
          <span className="font-medium">{device.hostname} <span className="font-mono text-12 text-tertiary">· {device.id.slice(0, 8)}</span></span>
          <span className="text-12 text-tertiary">{translate("devices.lastActivity")} {formatDate(device.lastActivityAt)} · {translate(device.daemonConnected ? "devices.connected" : "devices.disconnected")}</span>
          <span className="text-12 text-tertiary">{translate("tokens.expiry")} {device.expiresAt ? formatDate(device.expiresAt) : translate("tokens.never")}</span>
        </span>
        <span className={`rounded-full px-2 py-0.5 text-12 ${device.status === "active" ? "bg-accent-subtle text-accent-text" : "bg-layer-2 text-secondary"}`}>{translate(`devices.status.${device.status}`)}</span>
        <Button type="button" className="secondary hover:!text-danger-text" onClick={() => void revokeDevice(device)}>{translate("devices.revoke")}</Button>
      </Row>)}</RowList>}
      {deviceHistoryCount > 0 && <details className="mt-3 border-t border-subtle pt-3">
        <summary className="cursor-pointer text-13 font-medium">{translate("devices.history").replace("{count}", String(deviceHistoryCount))}</summary>
        <div className="mt-2"><RowList>{deviceHistory.map((device) => <Row key={device.id}>
          <span className="grid min-w-0 flex-1 gap-0.5"><span className="font-medium">{device.hostname} <span className="font-mono text-12 text-tertiary">· {device.id.slice(0, 8)}</span></span>
            <span className="text-12 text-tertiary"><span data-testid="device-history-status">{translate(`devices.status.${device.status}`)}</span> · {translate(device.status === "revoked" ? "devices.revokedAt" : "devices.expiredAt")} {device.status === "revoked" ? formatDate(device.revokedAt ?? device.createdAt) : formatDate(device.expiresAt ?? device.createdAt)}</span>
          </span>
          {device.status !== "revoked" && <Button type="button" className="secondary hover:!text-danger-text" onClick={() => void revokeDevice(device)}>{translate("devices.revoke")}</Button>}
        </Row>)}</RowList></div>
        {deviceHistoryHasMore && <Button type="button" className="secondary mt-3" onClick={() => void loadMoreDevices()}>{translate("devices.loadMore")}</Button>}
      </details>}
    </SettingsBlock>
    <SettingsHeader level={2} title={translate("tokens.activeTitle")} description={translate("tokens.activeDescription")} />
    <SettingsBlock>
      {loaded && tokens.filter((token) => token.kind === "personal").length === 0 && !failed && <p className="text-14 text-secondary">{translate("tokens.personalEmpty")}</p>}
      {tokens.filter((token) => token.kind === "personal").length > 0 && <RowList>{tokens.filter((token) => token.kind === "personal").map((token) => <Row key={token.id}>
        <span className="grid min-w-0 flex-1 gap-0.5"><span className="font-medium">{token.name}</span>
          {token.description && <span className="text-13 text-secondary">{token.description}</span>}
          <span className="text-12 text-tertiary">{token.prefix} · {translate("tokens.created")} {formatDate(token.createdAt)} · {translate("tokens.expiry")} {token.expiresAt ? formatDate(token.expiresAt) : translate("tokens.never")}</span>
          <span className="text-12 text-tertiary">{translate("tokens.lastUsed")} {token.lastUsedAt ? formatDate(token.lastUsedAt) : translate("tokens.notUsed")}</span>
        </span>
        <Button type="button" className="secondary" onClick={() => void revoke(token)}>{translate("tokens.revoke")}</Button>
      </Row>)}</RowList>}
      <h3 className="mb-2 mt-5 text-14 font-semibold">{translate("tokens.unassociatedTitle")}</h3>
      <p className="mb-3 text-13 text-secondary">{translate("tokens.unassociatedDescription")}</p>
      {tokens.filter((token) => token.kind === "daemon").length === 0 && !failed && <p className="text-14 text-secondary">{translate("tokens.legacyEmpty")}</p>}
      {tokens.filter((token) => token.kind === "daemon").length > 0 && <RowList>{tokens.filter((token) => token.kind === "daemon").map((token) => <Row key={token.id}>
        <span className="grid min-w-0 flex-1 gap-0.5"><span className="font-medium">{token.name}</span><span className="text-12 text-tertiary">{token.prefix} · {translate("tokens.created")} {formatDate(token.createdAt)} · {translate("tokens.expiry")} {token.expiresAt ? formatDate(token.expiresAt) : translate("tokens.never")}</span></span>
        <Button type="button" className="secondary hover:!text-danger-text" onClick={() => void revoke(token)}>{translate("tokens.revoke")}</Button>
      </Row>)}</RowList>}
      {tokenHistoryCount > 0 && <details className="mt-3 border-t border-subtle pt-3">
        <summary className="cursor-pointer text-13 font-medium">{translate("tokens.history").replace("{count}", String(tokenHistoryCount))}</summary>
        <div className="mt-2"><RowList>{tokenHistory.map((token) => <Row key={token.id}>
          <span className="grid min-w-0 flex-1 gap-0.5"><span className="font-medium">{token.name} <span className="text-12 text-secondary"><span data-testid="credential-history-status">{translate(`tokens.status.${token.status}`)}</span></span></span>
            <span className="text-12 text-tertiary">{token.prefix} · {translate("tokens.created")} {formatDate(token.createdAt)} · {translate(token.status === "revoked" ? "tokens.revokedAt" : "tokens.expiredAt")} {formatDate(token.status === "revoked" ? token.revokedAt ?? token.createdAt : token.expiresAt ?? token.createdAt)}</span></span>
          {token.status !== "revoked" && <Button type="button" className="secondary hover:!text-danger-text" onClick={() => void revokeHistoricalToken(token)}>{translate("tokens.revoke")}</Button>}
        </Row>)}</RowList></div>
        {tokenHistoryHasMore && <Button type="button" className="secondary mt-3" onClick={() => void loadMoreTokenHistory()}>{translate("tokens.loadMore")}</Button>}
      </details>}
      {failed && <Note note={translate("tokens.failed")} error />}
    </SettingsBlock>
    <SettingsHeader level={2} title={translate("apps.title")} description={translate("apps.description")} />
    <SettingsBlock>
      {apps.length === 0 ? <p className="text-14 text-secondary">{translate("apps.empty")}</p> : <RowList>{apps.map((app) => <Row key={app.id}>
        <span className="grid min-w-0 flex-1 gap-0.5"><span className="font-medium">{app.name}</span>
          <span className="text-12 text-tertiary">{translate("apps.allowed")} {formatDate(app.allowedAt)} · {translate("apps.lastIssued")} {app.lastUsedAt ? formatDate(app.lastUsedAt) : translate("tokens.notUsed")}</span>
        </span><Button type="button" className="secondary" onClick={() => void revokeApp(app)}>{translate("apps.revoke")}</Button>
      </Row>)}</RowList>}
    </SettingsBlock>
    <Note note={note} />
    {dialog && <div className="fixed inset-0 z-50 grid place-items-center bg-backdrop p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) closeDialog(); }}>
      <section role="dialog" aria-modal="true" aria-labelledby="token-dialog-title" className="grid w-full max-w-lg gap-4 rounded-xl border border-subtle bg-surface-1 p-5 shadow-xl">
        <header className="flex items-start justify-between gap-3"><div><h2 id="token-dialog-title" className="text-18 font-semibold">{secret ? translate("tokens.createdTitle") : translate("tokens.add")}</h2>
          <p className="mt-1 text-13 text-secondary">{secret ? translate("tokens.secretOnce") : translate("tokens.dialogDescription")}</p></div>
          <Button type="button" className="secondary" onClick={closeDialog}>{translate("settings.cancel")}</Button></header>
        {secret ? <div className="grid gap-3">
          <label>{translate("tokens.secret")}<input readOnly value={secret.token} className="font-mono" /></label>
          <p role="alert" className="m-0 rounded-md border border-danger-strong px-3 py-2 text-13 text-danger-text">{translate("tokens.secretWarning")}</p>
          <Button type="button" className="primary w-full !py-3 !text-16" onClick={async () => { if (await copyText(secret.token, translate("tokens.copied"), translate("comments.copyFailed"))) setNote(translate("tokens.copied")); }}>{translate("tokens.copy")}</Button>
          <div className="flex justify-end gap-2"><Button type="button" className="secondary" onClick={closeDialog}>{translate("settings.cancel")}</Button></div>
        </div> : <form className="grid gap-3" onSubmit={(event) => void create(event)}>
          <label>{translate("tokens.presetLabel")}<select value={preset} onChange={(event) => choosePreset(event.target.value as TokenPreset)}>
            {tokenPresets.map((item) => <option key={item} value={item}>{translate(`tokens.preset.${item}`)}</option>)}
          </select></label>
          <label>{translate("tokens.name")}<input required maxLength={100} autoFocus value={name} onChange={(event) => setName(event.target.value)} /></label>
          <label>{translate("tokens.fieldDescription")}<textarea maxLength={500} value={description} onChange={(event) => setDescription(event.target.value)} /></label>
          <label>{translate("tokens.customDate")}<input required={!neverExpires} type="date" min={todayTomorrow()} value={expiresAt} disabled={neverExpires} onChange={(event) => setExpiresAt(event.target.value)} /></label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={neverExpires} onChange={(event) => setNeverExpires(event.target.checked)} />{translate("tokens.neverExpires")}</label>
          <div className="flex justify-end gap-2"><Button type="button" className="secondary" onClick={closeDialog}>{translate("settings.cancel")}</Button><Button type="submit" disabled={!hasValidTokenExpiry(expiresAt, neverExpires)}>{translate("tokens.create")}</Button></div>
          {failed && <Note note={translate("tokens.failed")} error />}
        </form>}
      </section>
    </div>}
  </main>;
}

/** The old account URL. It opens the token screen inside the first workspace's shell, or bare when the person has no workspace. */
export function AccountApiTokensRoute() {
  const { current } = useRoot();
  const first = current.workspaces[0];
  if (first) return <Navigate to={paths.workspaceApiTokens(first.slug)} replace />;
  return <ApiTokensPage />;
}
