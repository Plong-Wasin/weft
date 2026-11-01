import React from "react";
import { Outlet, useNavigate } from "react-router";
import { formatDate, translate } from "@weft/shared";
import { action } from "../../api";
import { useWorkspace } from "../../layouts/workspace-layout";
import { roles, type Member } from "../../types";
import { dangerButton, DangerZone, Note, Row, RowList, SettingsBlock, SettingsHeader } from "./settings-ui";

/** Settings area: the contextual sidebar holds the section links, this layout holds the routed section page. */
export function SettingsLayout() {
  return <div className="mx-auto w-full max-w-[900px]"><Outlet /></div>;
}

/** The members of the current workspace and whether the viewer administers it. */
function useWorkspaceMembers() {
  const { workspace, selfId } = useWorkspace();
  const [members, setMembers] = React.useState<Member[] | null>(null);
  const load = React.useCallback(async () => setMembers(await action<Member[]>("list_members", { workspaceId: workspace.id }) ?? []), [workspace.id]);
  React.useEffect(() => { void load(); }, [load]);
  const isAdmin = members?.find((member) => member.userId === selfId)?.role === "Admin";
  return { workspace, selfId, members: members ?? [], isAdmin, load };
}

export function WorkspaceGeneral() {
  const { workspace, selfId, isAdmin } = useWorkspaceMembers();
  const { refresh } = useWorkspace();
  const navigate = useNavigate();
  const [note, setNote] = React.useState<string | null>(null);
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
      <label className="max-w-md">{translate("settings.workspaceName")}<input readOnly value={workspace.name} className="bg-layer-1" /></label>
      <label className="max-w-md">{translate("settings.workspaceUrl")}<input readOnly value={workspace.slug} className="bg-layer-1" /></label>
    </SettingsBlock>
    <DangerZone heading="settings.leaveWorkspace" description={translate(isAdmin ? "settings.leaveWorkspaceAdminDesc" : "settings.leaveWorkspaceDesc")}>
      <button type="button" className={dangerButton} onClick={leave}>{translate("settings.leave")}</button>
    </DangerZone>
    <Note note={note} error />
  </section>;
}

export function WorkspaceMembers() {
  const { workspace, members, isAdmin, load } = useWorkspaceMembers();
  const [note, setNote] = React.useState<string | null>(null);
  const guard = async (result: unknown) => { setNote(result === null ? translate("members.failed") : null); await load(); };
  return <section>
    <SettingsHeader title={translate("members.title")} description={translate("settings.membersDesc")} />
    <RowList>{members.map((member) => <Row key={member.userId}>
      <span className="grid min-w-0 flex-1"><span className="truncate font-medium">{member.name}</span><span className="truncate text-13 text-secondary">{member.email}</span></span>
      {isAdmin ? <select aria-label={`${translate("settings.roleOf")} ${member.name}`} value={member.role} onChange={async (event) => guard(await action("change_member_role", { workspaceId: workspace.id, userId: member.userId, role: event.target.value }))}>
        {roles.map((role) => <option key={role} value={role}>{translate(`members.role.${role}`)}</option>)}
      </select> : <span className="text-secondary">{translate(`members.role.${member.role}`)}</span>}
      {isAdmin && <button type="button" className="secondary" onClick={async () => guard(await action("remove_member", { workspaceId: workspace.id, userId: member.userId }))}>{translate("members.remove")}</button>}
    </Row>)}</RowList>
    <Note note={note} error />
  </section>;
}

type OpenInvite = { id: string; role: Member["role"]; createdBy: string; createdAt: string; expiresAt: string };

export function WorkspaceInvites() {
  const { workspace, members, isAdmin } = useWorkspaceMembers();
  const [invites, setInvites] = React.useState<OpenInvite[]>([]);
  const [role, setRole] = React.useState<Member["role"]>("Member");
  const [link, setLink] = React.useState<string | null>(null);
  const [note, setNote] = React.useState<string | null>(null);
  const [failed, setFailed] = React.useState(false);
  const load = React.useCallback(async () => setInvites(await action<OpenInvite[]>("list_open_invites", { workspaceId: workspace.id }) ?? []), [workspace.id]);
  React.useEffect(() => { if (isAdmin) void load(); }, [isAdmin, load]);
  const say = (message: string, error = false) => { setNote(message); setFailed(error); };
  if (!isAdmin) return <section><SettingsHeader title={translate("settings.invites")} description={translate("settings.invitesDesc")} /><p role="status" className="text-secondary">{translate("settings.adminOnly")}</p></section>;
  return <section>
    <SettingsHeader title={translate("settings.invites")} description={translate("settings.invitesDesc")} />
    <SettingsBlock title={translate("invite.create")}>
      <div className="flex flex-wrap items-end gap-3">
        <label>{translate("invite.role")}<select value={role} onChange={(event) => setRole(event.target.value as Member["role"])}>
          {roles.map((item) => <option key={item} value={item}>{translate(`members.role.${item}`)}</option>)}
        </select></label>
        <button type="button" onClick={async () => {
          const invite = await action<{ token: string }>("create_invite", { workspaceId: workspace.id, role });
          setLink(invite ? `${window.location.origin}/invite/${invite.token}` : null);
          if (invite) { say(translate("invite.expires")); await load(); } else say(translate("members.failed"), true);
        }}>{translate("invite.create")}</button>
      </div>
      {link && <div className="flex flex-wrap items-center gap-2"><input readOnly value={link} aria-label={translate("settings.inviteLink")} onFocus={(event) => event.target.select()} className="min-w-0 flex-1" />
        <button type="button" className="secondary" onClick={async () => { await navigator.clipboard.writeText(link); say(translate("invite.copied")); }}>{translate("invite.copy")}</button></div>}
    </SettingsBlock>
    <SettingsBlock title={translate("settings.openInvites")}>
      {invites.length === 0 ? <p className="text-secondary">{translate("settings.invitesNone")}</p> : <RowList>{invites.map((invite) => <Row key={invite.id}>
        <span className="grid min-w-0 flex-1"><span className="font-medium">{translate(`members.role.${invite.role}`)}</span>
          <span className="text-13 text-secondary">{translate("settings.invitedBy")} {members.find((member) => member.userId === invite.createdBy)?.name ?? "—"} · {translate("settings.expires")} {formatDate(invite.expiresAt)}</span></span>
        <button type="button" className="secondary" onClick={async () => {
          const result = await action("revoke_invite", { workspaceId: workspace.id, inviteId: invite.id });
          say(result === null ? translate("members.failed") : translate("settings.revoked"), result === null);
          await load();
        }}>{translate("settings.revoke")}</button>
      </Row>)}</RowList>}
    </SettingsBlock>
    <Note note={note} error={failed} />
  </section>;
}
