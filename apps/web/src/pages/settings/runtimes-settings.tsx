import React from "react";
import { translate } from "@weft/shared";
import { action, actionResult } from "../../api";
import { useWorkspace } from "../../layouts/workspace-layout";
import { Note, Row, RowList, SettingsBlock, SettingsHeader } from "./settings-ui";

type RuntimeProfile = { id: string; runtimeId: string; name: string; sandbox: "full" | "read-only" | "run-folder"; filesystemAllowlist: string[]; networkAllowlist: string[] };
type Runtime = { id: string; workspaceId: string; ownerId: string; ownerName: string; hostname: string; agentCli: "claude" | "codex"; shared: boolean; enforceSandbox: boolean; online: boolean; lastSeenAt: string };

function ProfileControls({ runtime, owner, reload }: { runtime: Runtime; owner: boolean; reload: () => void }) {
  const [profiles, setProfiles] = React.useState<RuntimeProfile[]>([]);
  const [name, setName] = React.useState("");
  const [sandbox, setSandbox] = React.useState<RuntimeProfile["sandbox"]>("run-folder");
  const [filesystem, setFilesystem] = React.useState("");
  const [network, setNetwork] = React.useState("");
  const [editingId, setEditingId] = React.useState<string | undefined>();
  const [error, setError] = React.useState(false);
  const load = React.useCallback(async () => setProfiles(await action<RuntimeProfile[]>("list_runtime_profiles", { runtimeId: runtime.id }) ?? []), [runtime.id]);
  React.useEffect(() => { void load(); }, [load]);
  const save = async (profileId?: string) => {
    const result = await action(profileId ? "update_runtime_profile" : "create_runtime_profile", { ...(profileId ? { profileId } : { runtimeId: runtime.id }), name, sandbox, filesystemAllowlist: filesystem.split("\n").map((v) => v.trim()).filter(Boolean), networkAllowlist: network.split(",").map((v) => v.trim()).filter(Boolean) });
    setError(result === null); if (result) { setName(""); setFilesystem(""); setNetwork(""); setEditingId(undefined); await load(); reload(); }
  };
  return <div className="mt-2 grid gap-2 rounded-md border border-subtle p-3">
    <strong className="text-13">{translate("runtimes.profiles")}</strong>
    <p className="m-0 text-12 text-secondary">{translate("runtimes.profileHelp")}</p>
    {profiles.map((profile) => <div key={profile.id} className="flex flex-wrap items-center gap-2 text-12"><span className="mr-auto">{profile.name} · {translate(`runtimes.sandbox.${profile.sandbox}` as never)}{profile.sandbox === "full" ? ` · ${translate("runtimes.fullAccessWarning")}` : ""}</span>{owner && <><button className="secondary" onClick={() => { setEditingId(profile.id); setName(profile.name); setSandbox(profile.sandbox); setFilesystem(profile.filesystemAllowlist.join("\n")); setNetwork(profile.networkAllowlist.join(", ")); }}>{translate("runtimes.editProfile")}</button><button className="secondary" onClick={async () => { if (!window.confirm(translate("runtimes.deleteProfileConfirm").replace("{name}", profile.name))) return; const result = await actionResult("delete_runtime_profile", { profileId: profile.id }); setError("error" in result); await load(); reload(); }}>{translate("runtimes.deleteProfile")}</button></>}</div>)}
    {owner && <><label className="text-12">{translate("runtimes.profileName")}<input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} /></label>
      <label className="text-12">{translate("runtimes.sandboxMode")}<select value={sandbox} onChange={(event) => setSandbox(event.target.value as RuntimeProfile["sandbox"])}><option value="run-folder">{translate("runtimes.sandbox.run-folder")}</option><option value="read-only">{translate("runtimes.sandbox.read-only")}</option><option value="full">{translate("runtimes.sandbox.full")}</option></select></label>
      {sandbox !== "full" && <><label className="text-12">{translate("runtimes.filesystemAllowlist")}<textarea value={filesystem} onChange={(event) => setFilesystem(event.target.value)} placeholder={translate("runtimes.filesystemPlaceholder")} /></label><label className="text-12">{translate("runtimes.networkAllowlist")}<input value={network} onChange={(event) => setNetwork(event.target.value)} placeholder={translate("runtimes.networkPlaceholder")} /></label></>}
      <button type="button" className="secondary justify-self-start" disabled={!name.trim()} onClick={() => void save(editingId)}>{translate(editingId ? "runtimes.saveProfile" : "runtimes.addProfile")}</button>
      {editingId && <button type="button" className="secondary justify-self-start" onClick={() => { setEditingId(undefined); setName(""); setFilesystem(""); setNetwork(""); setSandbox("run-folder"); setError(false); }}>{translate("comments.cancel")}</button>}
      <label className="flex items-center gap-2 text-12"><input type="checkbox" checked={runtime.enforceSandbox} onChange={async (event) => { const result = await action("set_runtime_sandbox_enforcement", { runtimeId: runtime.id, enforceSandbox: event.target.checked }); setError(result === null); reload(); }} />{translate("runtimes.enforceSandbox")}</label>
      {error && <p role="alert" className="m-0 text-12 text-danger-text">{translate("runtimes.failed")}</p>}</>}
  </div>;
}

export function WorkspaceRuntimes() {
  const { workspace, selfId } = useWorkspace();
  const [runtimes, setRuntimes] = React.useState<Runtime[]>([]);
  const [failed, setFailed] = React.useState(false);
  const load = React.useCallback(async () => {
    const result = await action<Runtime[]>("list_runtimes", { workspaceId: workspace.id });
    setFailed(result === null);
    setRuntimes(result ?? []);
  }, [workspace.id]);
  React.useEffect(() => { void load(); }, [load]);
  const toggle = async (runtime: Runtime) => {
    const result = await actionResult(runtime.shared ? "unshare_runtime" : "share_runtime", { runtimeId: runtime.id });
    if ("error" in result) { setFailed(true); return; }
    await load();
  };
  return <>
    <SettingsHeader title={translate("runtimes.title")} description={translate("runtimes.description")} />
    <SettingsBlock>
      <Note note={translate("runtimes.isolationWarning")} />
      <Note note={failed ? translate("runtimes.failed") : null} error={failed} />
      {runtimes.length === 0 ? <p className="text-14 text-secondary">{translate("runtimes.empty")}</p> : <RowList>
        {runtimes.map((runtime) => <Row key={runtime.id}><div className="mr-auto grid gap-0.5"><span className="font-medium">{runtime.ownerName} · {runtime.agentCli}</span><span className="text-13 text-secondary">{runtime.hostname} · {translate(runtime.online ? "runtimes.online" : "runtimes.offline")}</span></div>
          <span className="text-13 text-secondary">{runtime.shared ? translate("runtimes.shared") : translate("runtimes.private")}</span>
          {runtime.ownerId === selfId && <button type="button" className="secondary" onClick={() => void toggle(runtime)}>{translate(runtime.shared ? "runtimes.unshare" : "runtimes.share")}</button>}
          <ProfileControls runtime={runtime} owner={runtime.ownerId === selfId} reload={() => void load()} />
        </Row>)}
      </RowList>}
    </SettingsBlock>
  </>;
}
