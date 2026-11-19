import React from "react";
import { Link } from "react-router";
import { formatDate, translate } from "@weft/shared";
import { action, actionResult } from "../../api";
import { Dialog } from "../../dialog";
import { useWorkspace } from "../../layouts/workspace-layout";
import { paths } from "../../routes";
import type { Member } from "../../types";
import { dangerButton, dangerOutline, Note, Row, RowList, SettingsBlock, SettingsHeader } from "./settings-ui";

type RuntimeProfile = { id: string; runtimeId: string; name: string; sandbox: "full" | "read-only" | "run-folder"; filesystemAllowlist: string[]; networkAllowlist: string[] };
type Runtime = {
  id: string; workspaceId: string; ownerId: string; ownerName: string; hostname: string; agentCli: "claude" | "codex"; shared: boolean; enforceSandbox: boolean; online: boolean; lastSeenAt: string;
  offlineSeconds: number | null; agents: Array<{ id: string; name: string; enabled: boolean }>; waitingRuns: number; unfinishedRuns: number;
  sessionFolders: Array<{ folder: string; workItem: { id: string; displayId: string; title: string }; lastUsedAt: string }>;
};

/** Offline Runtimes first, the one offline longest at the top; an unknown offline time counts as the longest. Online ones keep the server's order. */
function orderRuntimes(list: Runtime[]): Runtime[] {
  const offline = list.filter((runtime) => !runtime.online).sort((a, b) => Date.parse(a.lastSeenAt) - Date.parse(b.lastSeenAt));
  return [...offline, ...list.filter((runtime) => runtime.online)];
}

/** A duration in at most two units, such as "2 d 4 h", "3 h 12 min" or "12 min". */
function offlineDuration(seconds: number): string {
  if (seconds < 60) return translate("runtimes.duration.underMinute");
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const count = (key: "runtimes.duration.days" | "runtimes.duration.hours" | "runtimes.duration.minutes", value: number) => translate(key).replace("{count}", String(value));
  if (days) return [count("runtimes.duration.days", days), hours ? count("runtimes.duration.hours", hours) : ""].filter(Boolean).join(" ");
  if (hours) return [count("runtimes.duration.hours", hours), minutes ? count("runtimes.duration.minutes", minutes) : ""].filter(Boolean).join(" ");
  return count("runtimes.duration.minutes", minutes);
}

function offlineText(runtime: Runtime): string {
  // A Runtime whose time is unknown was reset to the epoch before its last-seen time was kept: no count is shown for it.
  return runtime.offlineSeconds === null ? translate("runtimes.offlineUnknown") : translate("runtimes.offlineFor").replace("{duration}", offlineDuration(runtime.offlineSeconds));
}

function RuntimeUsage({ runtime }: { runtime: Runtime }) {
  const folders = runtime.sessionFolders;
  return <div className="grid w-full gap-1 text-13">
    <span className="text-secondary">{runtime.agents.length ? translate("runtimes.boundAgents").replace("{names}", runtime.agents.map((agent) => agent.name).join(", ")) : translate("runtimes.noBoundAgents")}</span>
    <span className="text-secondary">{translate("runtimes.waitingRuns").replace("{count}", String(runtime.waitingRuns))}</span>
    {runtime.waitingRuns > 0 && !runtime.online && <p className="m-0 text-12 text-secondary">{translate("runtimes.waitingRunsHelp")}</p>}
    <details>
      <summary className="cursor-pointer text-secondary">{translate("runtimes.sessionFolders").replace("{count}", String(folders.length))}</summary>
      {folders.length === 0 ? <p className="m-0 mt-1 text-12 text-secondary">{translate("runtimes.noSessionFolders")}</p> : <>
        <p className="m-0 mt-1 text-12 text-secondary">{translate("runtimes.sessionFoldersHelp")}</p>
        <ul className="m-0 mt-2 grid list-none gap-2 p-0">
          {folders.map((folder) => <li key={folder.folder} className="grid min-w-0 gap-0.5">
            <span className="break-words">{folder.workItem.displayId} · {folder.workItem.title}</span>
            <span className="text-12 text-secondary">{translate("runtimes.folderLastUsed").replace("{time}", formatDate(folder.lastUsedAt))}</span>
            <code className="break-all text-12">{folder.folder}</code>
          </li>)}
        </ul>
      </>}
    </details>
  </div>;
}

function ProfileControls({ runtime, owner, reload }: { runtime: Runtime; owner: boolean; reload: () => void }) {
  const [profiles, setProfiles] = React.useState<RuntimeProfile[]>([]);
  const [name, setName] = React.useState("");
  const [sandbox, setSandbox] = React.useState<RuntimeProfile["sandbox"]>("run-folder");
  const [filesystem, setFilesystem] = React.useState("");
  const [network, setNetwork] = React.useState("");
  const [editingId, setEditingId] = React.useState<string | undefined>();
  const [error, setError] = React.useState(false);
  const [loaded, setLoaded] = React.useState(false);
  const [expanded, setExpanded] = React.useState(false);
  const load = React.useCallback(async () => { setProfiles(await action<RuntimeProfile[]>("list_runtime_profiles", { runtimeId: runtime.id }) ?? []); setLoaded(true); }, [runtime.id]);
  React.useEffect(() => { void load(); }, [load]);
  const save = async (profileId?: string) => {
    const result = await action(profileId ? "update_runtime_profile" : "create_runtime_profile", { ...(profileId ? { profileId } : { runtimeId: runtime.id }), name, sandbox, filesystemAllowlist: filesystem.split("\n").map((v) => v.trim()).filter(Boolean), networkAllowlist: network.split(",").map((v) => v.trim()).filter(Boolean) });
    setError(result === null); if (result) { setName(""); setFilesystem(""); setNetwork(""); setEditingId(undefined); await load(); reload(); }
  };
  // Collapsed by default: with several Runtimes an open form under each one buried the facts the page is for. It stays where the owner left it: starting an edit opens it, saving or cancelling does not close it.
  return <details className="w-full rounded-md border border-subtle p-3" open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}>
    <summary className="cursor-pointer text-13 font-medium max-sm:py-2">{translate("runtimes.profiles")}{loaded ? ` · ${profiles.length}` : ""}</summary>
    <div className="mt-2 grid gap-2">
    <p className="m-0 text-12 text-secondary">{translate("runtimes.profileHelp")}</p>
    {profiles.map((profile) => <div key={profile.id} className="flex flex-wrap items-center gap-2 text-12"><span className="mr-auto">{profile.name} · {translate(`runtimes.sandbox.${profile.sandbox}` as never)}{profile.sandbox === "full" ? ` · ${translate("runtimes.fullAccessWarning")}` : ""}</span>{owner && <><button className="secondary" onClick={() => { setExpanded(true); setEditingId(profile.id); setName(profile.name); setSandbox(profile.sandbox); setFilesystem(profile.filesystemAllowlist.join("\n")); setNetwork(profile.networkAllowlist.join(", ")); }}>{translate("runtimes.editProfile")}</button><button className="secondary" onClick={async () => { if (!window.confirm(translate("runtimes.deleteProfileConfirm").replace("{name}", profile.name))) return; const result = await actionResult("delete_runtime_profile", { profileId: profile.id }); setError("error" in result); await load(); reload(); }}>{translate("runtimes.deleteProfile")}</button></>}</div>)}
    {owner && <><label className="text-12">{translate("runtimes.profileName")}<input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} /></label>
      <label className="text-12">{translate("runtimes.sandboxMode")}<select value={sandbox} onChange={(event) => setSandbox(event.target.value as RuntimeProfile["sandbox"])}><option value="run-folder">{translate("runtimes.sandbox.run-folder")}</option><option value="read-only">{translate("runtimes.sandbox.read-only")}</option><option value="full">{translate("runtimes.sandbox.full")}</option></select></label>
      {sandbox !== "full" && <><label className="text-12">{translate("runtimes.filesystemAllowlist")}<textarea value={filesystem} onChange={(event) => setFilesystem(event.target.value)} placeholder={translate("runtimes.filesystemPlaceholder")} /></label><label className="text-12">{translate("runtimes.networkAllowlist")}<input value={network} onChange={(event) => setNetwork(event.target.value)} placeholder={translate("runtimes.networkPlaceholder")} /></label></>}
      <button type="button" className="secondary justify-self-start" disabled={!name.trim()} onClick={() => void save(editingId)}>{translate(editingId ? "runtimes.saveProfile" : "runtimes.addProfile")}</button>
      {editingId && <button type="button" className="secondary justify-self-start" onClick={() => { setEditingId(undefined); setName(""); setFilesystem(""); setNetwork(""); setSandbox("run-folder"); setError(false); }}>{translate("comments.cancel")}</button>}
      <label className="flex items-center gap-2 text-12"><input type="checkbox" checked={runtime.enforceSandbox} onChange={async (event) => { const result = await action("set_runtime_sandbox_enforcement", { runtimeId: runtime.id, enforceSandbox: event.target.checked }); setError(result === null); reload(); }} />{translate("runtimes.enforceSandbox")}</label>
      {error && <p role="alert" className="m-0 text-12 text-danger-text">{translate("runtimes.failed")}</p>}</>}
    </div>
  </details>;
}

/** Delete for the Runtime owner and workspace Admins. A refusal shows what still uses the Runtime, from the list the page already holds; an Admin also chooses what happens to the Agents. */
function DeleteRuntime({ runtime, targets, isAdmin, reload }: { runtime: Runtime; targets: Runtime[]; isAdmin: boolean; reload: () => void }) {
  const [open, setOpen] = React.useState(false);
  const [refused, setRefused] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [moveTo, setMoveTo] = React.useState("");
  const closeButton = React.useRef<HTMLButtonElement>(null);
  // The refusal replaces the content under the focus: land on Close, never on a button that deletes.
  React.useEffect(() => { if (refused) closeButton.current?.focus(); }, [refused]);
  const close = () => { setOpen(false); setRefused(false); setFailed(false); setMoveTo(""); };
  const run = async (options: Record<string, unknown>) => {
    setBusy(true);
    const result = await actionResult("delete_runtime", { runtimeId: runtime.id, ...options });
    setBusy(false);
    if (!("error" in result)) { close(); reload(); return; }
    if (result.code === "runtime_in_use") { setRefused(true); reload(); return; }
    setFailed(true);
  };
  const enabledAgents = runtime.agents.filter((agent) => agent.enabled).map((agent) => agent.name);
  const target = targets.find((candidate) => candidate.id === moveTo);
  // Unfinished Runs refuse both choices too, so the Admin is offered them only when none is left.
  const adminChoices = isAdmin && refused && runtime.unfinishedRuns === 0;
  return <>
    <button type="button" className={dangerOutline} onClick={() => setOpen(true)}>{translate("runtimes.delete")}</button>
    {open && <Dialog title={translate(refused ? "runtimes.deleteRefusedTitle" : "runtimes.deleteTitle")} onClose={close}>
      <p className="m-0 text-14 font-medium">{runtime.ownerName} · {runtime.agentCli} · {runtime.hostname}</p>
      {refused ? <>
        {enabledAgents.length > 0 && <p className="m-0 text-14">{translate(adminChoices ? "runtimes.deleteRefusedAgentsAdmin" : "runtimes.deleteRefusedAgents").replace("{names}", enabledAgents.join(", "))}</p>}
        {runtime.unfinishedRuns > 0 && <p className="m-0 text-14">{translate("runtimes.deleteRefusedRuns").replace("{count}", String(runtime.unfinishedRuns))}</p>}
        {enabledAgents.length === 0 && runtime.unfinishedRuns === 0 && <p className="m-0 text-14">{translate("runtimes.deleteRefusedOther")}</p>}
        {adminChoices && <div className="grid gap-2 rounded-md border border-subtle p-3">
          <strong className="text-13">{translate("runtimes.adminChoiceTitle")}</strong>
          <span className="text-13 text-secondary">{translate("runtimes.boundAgents").replace("{names}", runtime.agents.map((agent) => agent.name).join(", "))}</span>
          <p className="m-0 text-12 text-secondary">{translate("runtimes.unbindHelp")}</p>
          <button type="button" className={`${dangerOutline} justify-self-start`} disabled={busy} onClick={() => void run({ boundAgents: "unbind" })}>{translate("runtimes.unbindAndDelete")}</button>
          <hr className="m-0 border-subtle" />
          {targets.length === 0 ? <p className="m-0 text-12 text-secondary">{translate("runtimes.moveNoTargets")}</p> : <>
            <p className="m-0 text-12 text-secondary">{translate("runtimes.moveHelp")}</p>
            <label className="text-12">{translate("runtimes.moveTarget")}<select value={moveTo} onChange={(event) => setMoveTo(event.target.value)}>
              <option value="">{translate("runtimes.moveTarget")}</option>
              {targets.map((candidate) => <option key={candidate.id} value={candidate.id}>{`${candidate.ownerName} · ${candidate.agentCli} · ${candidate.hostname}`}</option>)}
            </select></label>
            {target && target.ownerId !== runtime.ownerId && <p role="note" className="m-0 text-12 text-danger-text">{translate("runtimes.moveOwnerWarning").replace("{owner}", target.ownerName)}</p>}
            <button type="button" className={`${dangerOutline} justify-self-start`} disabled={busy || !target} onClick={() => void run({ boundAgents: { moveTo: target!.id } })}>{translate("runtimes.moveAndDelete")}</button>
          </>}
        </div>}
        <div className="flex justify-end"><button type="button" ref={closeButton} className="secondary max-sm:min-h-11" onClick={close}>{translate("runtimes.deleteClose")}</button></div>
      </> : <>
        <p className="m-0 text-14">{translate("runtimes.deleteBody")}</p>
        {runtime.online && <p className="m-0 text-14" data-testid="delete-online-note">{translate("runtimes.deleteOnlineNote")}</p>}
        {failed && <p role="alert" className="m-0 text-12 text-danger-text">{translate("runtimes.failed")}</p>}
        <div className="flex justify-end gap-2"><button type="button" className="secondary" onClick={close}>{translate("comments.cancel")}</button><button type="button" className={dangerButton} disabled={busy} onClick={() => void run({})}>{translate("runtimes.deleteConfirm")}</button></div>
      </>}
    </Dialog>}
  </>;
}

export function WorkspaceRuntimes() {
  const { workspace, selfId } = useWorkspace();
  const [runtimes, setRuntimes] = React.useState<Runtime[]>([]);
  const [failed, setFailed] = React.useState(false);
  const [isAdmin, setIsAdmin] = React.useState(false);
  const load = React.useCallback(async () => {
    const [result, members] = await Promise.all([action<Runtime[]>("list_runtimes", { workspaceId: workspace.id }), action<Member[]>("list_members", { workspaceId: workspace.id })]);
    setFailed(result === null);
    setRuntimes(orderRuntimes(result ?? []));
    setIsAdmin(members?.find((member) => member.userId === selfId)?.role === "Admin");
  }, [workspace.id, selfId]);
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
      {runtimes.length === 0 ? <Link to={paths.workspaceConnectAi(workspace.slug)} className="text-14 text-accent-text underline">{translate("runtimes.connectLink")}</Link> : <RowList>
        {runtimes.map((runtime) => <Row key={runtime.id}><div className="grid w-full gap-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-x-3">
            <div className="grid min-w-0 gap-0.5 sm:mr-auto">
              <span className="flex min-w-0 items-center gap-2 font-medium">
                <span aria-hidden className={`size-2 shrink-0 rounded-full ${runtime.online ? "bg-success-primary" : "bg-warning-primary"}`} />
                <span className="truncate">{runtime.ownerName} · {runtime.agentCli}</span>
              </span>
              <span className="break-words text-13 text-secondary">{runtime.hostname} · {runtime.online ? translate("runtimes.online") : offlineText(runtime)}</span>
            </div>
            <div className="flex flex-wrap items-center gap-2 sm:gap-x-3">
            <span className="mr-auto text-13 text-secondary sm:mr-0">{runtime.shared ? translate("runtimes.shared") : translate("runtimes.private")}</span>
            {runtime.ownerId === selfId && <button type="button" className="secondary max-sm:min-h-11" onClick={() => void toggle(runtime)}>{translate(runtime.shared ? "runtimes.unshare" : "runtimes.share")}</button>}
            {(runtime.ownerId === selfId || isAdmin) && <DeleteRuntime runtime={runtime} targets={runtimes.filter((candidate) => candidate.shared && candidate.id !== runtime.id)} isAdmin={isAdmin} reload={() => void load()} />}
            </div>
          </div>
          <RuntimeUsage runtime={runtime} />
          <ProfileControls runtime={runtime} owner={runtime.ownerId === selfId} reload={() => void load()} />
        </div>
        </Row>)}
      </RowList>}
    </SettingsBlock>
  </>;
}
