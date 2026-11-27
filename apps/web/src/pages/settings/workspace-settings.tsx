import { Button } from "@/ui/button";
import React from "react";
import { copyText } from "../../toast";
import { Outlet, useNavigate } from "react-router";
import { formatDate, formatNumber, translate } from "@weft/shared";
import { useQuery } from "@tanstack/react-query";
import { action } from "../../api";
import { aiStatusKey, requestAiStatus } from "../../ai-status";
import { useAiOffReason, useAiState } from "../../ai-flag";
import { useWorkspace } from "../../layouts/workspace-layout";
import { roles, type Member } from "../../types";
import { Avatar, AgentLabel } from "../../avatar";
import { dangerOutline, DangerZone, Note, Row, RowList, SettingsBlock, SettingsHeader } from "./settings-ui";
import { adminState } from "../../admin-state";
import { AuditLogPage, MemberSecurityList } from "./member-security";

import { Checkbox } from "@/ui/checkbox";
import { Input } from "@/ui/input";
const fillMessage = (message: string, values: Record<string, string>) => Object.entries(values).reduce((result, [key, value]) => result.split(`{${key}}`).join(value), message);

/** Settings area: the contextual sidebar holds the section links, this layout holds the routed section page. */
export function SettingsLayout() {
  return <div className="w-full min-w-0"><Outlet /></div>;
}

/** The members of the current workspace and whether the viewer administers it. */
export function useWorkspaceMembers() {
  const { workspace, selfId } = useWorkspace();
  const [members, setMembers] = React.useState<Member[] | null>(null);
  const load = React.useCallback(async () => setMembers(await action<Member[]>("list_members", { workspaceId: workspace.id }) ?? []), [workspace.id]);
  React.useEffect(() => { void load(); }, [load]);
  const state = adminState(members, selfId);
  return { workspace, selfId, members: members ?? [], isAdmin: state === "admin", adminLoading: state === "loading", load };
}

export function WorkspaceGeneral() {
  const { workspace, selfId, isAdmin, adminLoading } = useWorkspaceMembers();
  const { refresh } = useWorkspace();
  const navigate = useNavigate();
  const [note, setNote] = React.useState<string | null>(null);
  const { data: autopilot, refetch: reloadAutopilot } = useQuery({ queryKey: ["autopilot-setting", workspace.id], queryFn: () => action<{ allowAutopilot: boolean }>("get_autopilot_setting", { workspaceId: workspace.id }) });
  const { data: runLimits, refetch: reloadRunLimits } = useQuery({ queryKey: ["runtime-run-limits", workspace.id], queryFn: () => action<{ runsPerPersonPerHour: number; runsPerAgentPerHour: number }>("get_runtime_run_limits", { workspaceId: workspace.id }) });
  const [runLimitDraft, setRunLimitDraft] = React.useState<{ runsPerPersonPerHour: number; runsPerAgentPerHour: number } | null>(null);
  const leave = async () => {
    if (!window.confirm(translate("settings.leaveConfirm"))) return;
    const result = await action("remove_member", { workspaceId: workspace.id, userId: selfId });
    if (result === null) { setNote(translate("members.failed")); return; }
    await refresh();
    navigate("/", { replace: true });
  };
  return <section>
    <SettingsHeader title={translate("settings.workspaceTitle")} description={translate("settings.workspaceGeneralDesc")} />
    <SettingsBlock>
      <label className="max-w-md">{translate("settings.workspaceName")}<Input readOnly tabIndex={-1} value={workspace.name} /></label>
      <label className="max-w-md">{translate("settings.workspaceUrl")}<Input readOnly tabIndex={-1} value={workspace.slug} /></label>
    </SettingsBlock>
    <SettingsBlock title={translate("settings.autopilot")}>
      <label className="flex items-center gap-2"><Checkbox checked={autopilot?.allowAutopilot ?? false} disabled={!isAdmin || !autopilot} onChange={async (event) => {
        const updated = await action("set_autopilot_setting", { workspaceId: workspace.id, allowAutopilot: event.target.checked });
        if (updated === null) setNote(translate("members.failed")); else { setNote(null); await reloadAutopilot(); }
      }} />{translate("settings.allowAutopilot")}</label>
    </SettingsBlock>
    <SettingsBlock title={translate("settings.runtimeRunLimits")}>
      <p className="text-13 text-muted-foreground">{translate("settings.runtimeRunLimitsDesc")}</p>
      <label className="max-w-xs">{translate("settings.runsPerPersonPerHour")}<Input type="number" min={1} max={10000} disabled={!isAdmin} value={(runLimitDraft ?? runLimits)?.runsPerPersonPerHour ?? 30} onChange={(event) => setRunLimitDraft({ ...(runLimitDraft ?? runLimits ?? { runsPerPersonPerHour: 30, runsPerAgentPerHour: 30 }), runsPerPersonPerHour: Number(event.target.value) })} /></label>
      <label className="max-w-xs">{translate("settings.runsPerAgentPerHour")}<Input type="number" min={1} max={10000} disabled={!isAdmin} value={(runLimitDraft ?? runLimits)?.runsPerAgentPerHour ?? 30} onChange={(event) => setRunLimitDraft({ ...(runLimitDraft ?? runLimits ?? { runsPerPersonPerHour: 30, runsPerAgentPerHour: 30 }), runsPerAgentPerHour: Number(event.target.value) })} /></label>
      {isAdmin && <Button type="button" className="w-fit pointer-coarse:min-h-11" disabled={!runLimitDraft || runLimitDraft.runsPerPersonPerHour < 1 || runLimitDraft.runsPerAgentPerHour < 1} onClick={async () => {
        if (!runLimitDraft) return;
        const updated = await action("set_runtime_run_limits", { workspaceId: workspace.id, ...runLimitDraft });
        if (updated === null) setNote(translate("members.failed")); else { setNote(null); setRunLimitDraft(null); await reloadRunLimits(); }
      }}>{translate("settings.saveRunLimits")}</Button>}
    </SettingsBlock>
    {!adminLoading && <DangerZone heading="settings.leaveWorkspace" description={translate(isAdmin ? "settings.leaveWorkspaceAdminDesc" : "settings.leaveWorkspaceDesc")}>
      <Button type="button" className={dangerOutline} onClick={leave}>{translate("settings.leave")}</Button>
    </DangerZone>}
    <Note note={note} error />
  </section>;
}

export function WorkspaceMembers() {
  const { workspace, members, isAdmin, adminLoading, load, selfId } = useWorkspaceMembers();
  const [note, setNote] = React.useState<string | null>(null);
  const guard = async (result: unknown) => { setNote(result === null ? translate("members.failed") : null); await load(); };
  return <section>
    <SettingsHeader title={translate("members.title")} description={translate("settings.membersDesc")} />
    {adminLoading ? <p role="status" className="text-muted-foreground">{translate("account.loading")}</p> : <RowList>{members.map((member) => <Row key={member.userId}>
      <Avatar name={member.name} id={member.userId} agent={member.isAgent} size="md" /><span className="grid min-w-[min(100%,14rem)] flex-1 gap-0.5"><span className="flex flex-wrap items-center gap-1.5 [overflow-wrap:anywhere] font-medium">{member.name}{member.isAgent && <AgentLabel />}</span><span className="break-all text-13 text-muted-foreground">{member.email}</span></span>
      {isAdmin && !member.isAgent ? <select aria-label={`${translate("settings.roleOf")} ${member.name}`} value={member.role} onChange={async (event) => guard(await action("change_member_role", { workspaceId: workspace.id, userId: member.userId, role: event.target.value }))}>
        {roles.map((role) => <option key={role} value={role}>{translate(`members.role.${role}`)}</option>)}
      </select> : <span className="text-muted-foreground">{translate(`members.role.${member.role}`)}</span>}
      {isAdmin && !member.isAgent && <Button type="button" className="hover:!text-destructive" aria-label={fillMessage(translate("members.removeNamed"), { name: member.name })} onClick={async () => { if (!window.confirm(translate("members.removeConfirm"))) return; await guard(await action("remove_member", { workspaceId: workspace.id, userId: member.userId })); }}>{translate("members.remove")}</Button>}
    </Row>)}</RowList>}
    <Note note={note} error />
    {isAdmin && <div className="mt-8"><MemberSecurityList workspaceId={workspace.id} selfId={selfId} onChanged={load} /></div>}
  </section>;
}

/** The audit log is for Admins; others see why it is closed. */
export function WorkspaceAudit() {
  const { workspace, members, isAdmin, adminLoading } = useWorkspaceMembers();
  if (!isAdmin) return <section><SettingsHeader title={translate("account.auditTitle")} description={translate("account.auditDesc")} /><p role="status" className="text-muted-foreground">{translate(adminLoading ? "account.loading" : "account.auditAdminOnly")}</p></section>;
  return <AuditLogPage workspaceId={workspace.id} members={members.filter((member) => !member.isAgent)} />;
}

type OpenInvite = { id: string; role: Member["role"]; createdBy: string; createdAt: string; expiresAt: string };

export function WorkspaceInvites() {
  const { workspace, members, isAdmin, adminLoading } = useWorkspaceMembers();
  const [invites, setInvites] = React.useState<OpenInvite[]>([]);
  const [role, setRole] = React.useState<Member["role"]>("Member");
  const [link, setLink] = React.useState<string | null>(null);
  const [note, setNote] = React.useState<string | null>(null);
  const [failed, setFailed] = React.useState(false);
  const load = React.useCallback(async () => setInvites(await action<OpenInvite[]>("list_open_invites", { workspaceId: workspace.id }) ?? []), [workspace.id]);
  React.useEffect(() => { if (isAdmin) void load(); }, [isAdmin, load]);
  const say = (message: string, error = false) => { setNote(message); setFailed(error); };
  const inviteGroups = new Map<string, OpenInvite[]>();
  for (const invite of invites) {
    const creator = members.find((member) => member.userId === invite.createdBy)?.name ?? "—";
    const identity = JSON.stringify([translate(`members.role.${invite.role}`), creator, formatDate(invite.createdAt)]);
    const group = inviteGroups.get(identity) ?? [];
    group.push(invite);
    inviteGroups.set(identity, group);
  }
  const inviteInstances = new Map<string, string>();
  for (const group of inviteGroups.values()) {
    if (group.length < 2) continue;
    group.forEach((invite, index) => inviteInstances.set(invite.id, fillMessage(translate("settings.inviteInstance"), { number: formatNumber(index + 1), total: formatNumber(group.length) })));
  }
  if (!isAdmin) return <section><SettingsHeader title={translate("settings.invites")} description={translate("settings.invitesDesc")} /><p role="status" className="text-muted-foreground">{translate(adminLoading ? "account.loading" : "settings.adminOnly")}</p></section>;
  return <section>
    <SettingsHeader title={translate("settings.invites")} description={translate("settings.invitesDesc")} />
    <SettingsBlock title={translate("invite.create")}>
      <div className="flex flex-wrap items-end gap-3">
        <label>{translate("invite.role")}<select value={role} onChange={(event) => setRole(event.target.value as Member["role"])}>
          {roles.map((item) => <option key={item} value={item}>{translate(`members.role.${item}`)}</option>)}
        </select></label>
        <Button type="button" onClick={async () => {
          const invite = await action<{ token: string }>("create_invite", { workspaceId: workspace.id, role });
          setLink(invite ? `${window.location.origin}/invite/${invite.token}` : null);
          if (invite) { say(translate("invite.expires")); await load(); } else say(translate("members.failed"), true);
        }}>{translate("invite.create")}</Button>
      </div>
      {link && <div className="flex flex-wrap items-center gap-2"><Input readOnly value={link} aria-label={translate("settings.inviteLink")} onFocus={(event) => event.target.select()} className="min-w-0 flex-1" />
        <Button type="button" onClick={async () => { if (await copyText(link, translate("invite.copied"), translate("comments.copyFailed"))) say(translate("invite.copied")); }}>{translate("invite.copy")}</Button></div>}
    </SettingsBlock>
    <SettingsBlock title={translate("settings.openInvites")}>
      {invites.length === 0 ? <p className="text-muted-foreground">{translate("settings.invitesNone")}</p> : <RowList>{invites.map((invite) => <Row key={invite.id}>
        <span className="grid min-w-0 flex-1"><span className="flex flex-wrap items-center gap-2 font-medium">{translate(`members.role.${invite.role}`)}{inviteInstances.has(invite.id) && <span className="text-12 font-normal text-muted-foreground">{inviteInstances.get(invite.id)}</span>}</span>
          <span className="text-13 text-muted-foreground">{translate("settings.invitedBy")} {members.find((member) => member.userId === invite.createdBy)?.name ?? "—"} · {translate("settings.expires")} {formatDate(invite.expiresAt)}</span></span>
        <Button type="button" className="hover:!text-destructive" onClick={async () => {
          const result = await action("revoke_invite", { workspaceId: workspace.id, inviteId: invite.id });
          // Refresh first so the "revoked" note never shows while the revoked invite is still listed.
          await load();
          say(result === null ? translate("members.failed") : translate("settings.revoked"), result === null);
        }} aria-label={`${fillMessage(translate("settings.revokeInviteNamed"), { role: translate(`members.role.${invite.role}`), creator: members.find((member) => member.userId === invite.createdBy)?.name ?? "—", date: formatDate(invite.createdAt) })}${inviteInstances.has(invite.id) ? `, ${inviteInstances.get(invite.id)}` : ""}`}>{translate("settings.revoke")}</Button>
      </Row>)}</RowList>}
    </SettingsBlock>
    <Note note={note} error={failed} />
  </section>;
}

/** Whether the AI is configured: provider, model, and key present or missing. The key itself never reaches the browser. */
export function WorkspaceAi() {
  const { workspace } = useWorkspace();
  const aiState = useAiState();
  const offReason = useAiOffReason();
  // With AI off the status route answers 404, so the page explains the cause from /api/config instead of asking it.
  const { data, isPending } = useQuery({ queryKey: aiStatusKey(workspace.id), queryFn: () => requestAiStatus(workspace.id), enabled: aiState === "on" });
  if (aiState === "unknown") return null;
  return <section>
    <SettingsHeader title={translate("aiStatus.title")} description={translate("aiStatus.desc")} />
    {aiState === "off" ? <p role="status" data-testid="ai-off-reason" className="text-muted-foreground">{translate(offReason === "switched_off" ? "aiStatus.off.switched_off" : "aiStatus.off.no_provider_key")}</p> : isPending ? null : !data ? <p role="alert" className="text-destructive">{translate("aiStatus.unknown")}</p> : <>
      <SettingsBlock>
        <RowList>
          <Row><span className="flex-1 text-muted-foreground">{translate("aiStatus.provider")}</span><span data-testid="ai-provider" className="font-medium">{data.provider}</span></Row>
          <Row><span className="flex-1 text-muted-foreground">{translate("aiStatus.model")}</span><span data-testid="ai-model" className="font-medium">{data.model}</span></Row>
          <Row><span className="flex-1 text-muted-foreground">{translate("aiStatus.key")}</span><span data-testid="ai-key" className="font-medium">{translate(`aiStatus.key.${data.key}`)}</span></Row>
        </RowList>
      </SettingsBlock>
      <p role="status" className={data.configured ? "text-muted-foreground" : "text-destructive"}>{translate(data.configured ? "aiStatus.configured" : "aiStatus.missing")}</p>
    </>}
  </section>;
}
