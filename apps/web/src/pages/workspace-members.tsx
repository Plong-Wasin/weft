import React from "react";
import { translate } from "@weft/shared";
import { action, actionResult } from "../api";
import { useWorkspace } from "../layouts/workspace-layout";
import type { Member } from "../types";
import { roles } from "../types";

export function MembersPanel() {
  const { workspace, selfId: self } = useWorkspace();
  const [members, setMembers] = React.useState<Member[]>([]);
  const [inviteRole, setInviteRole] = React.useState<Member["role"]>("Member");
  const [link, setLink] = React.useState<string | null>(null);
  const [note, setNote] = React.useState<string | null>(null);
  const load = React.useCallback(async () => setMembers(await action<Member[]>("list_members", { workspaceId: workspace.id }) ?? []), [workspace.id]);
  React.useEffect(() => { void load(); }, [load]);
  const mine = members.find((member) => member.userId === self);
  const isAdmin = mine?.role === "Admin";
  const guard = async (result: unknown) => { setNote(result === null ? translate("members.failed") : null); await load(); };
  return <section>
    <h2>{translate("members.title")}</h2>
    <ul>{members.map((member) => <li key={member.userId}>
      {member.name} ({member.email}){" "}
      {isAdmin ? <select value={member.role} onChange={async (event) => guard(await action("change_member_role", { workspaceId: workspace.id, userId: member.userId, role: event.target.value }))}>
        {roles.map((role) => <option key={role} value={role}>{translate(`members.role.${role}`)}</option>)}
      </select> : <span>{translate(`members.role.${member.role}`)}</span>}
      {isAdmin && <button className="secondary" onClick={async () => guard(await action("remove_member", { workspaceId: workspace.id, userId: member.userId }))}>{translate("members.remove")}</button>}
    </li>)}</ul>
    {isAdmin && <div>
      <label>{translate("invite.role")}<select value={inviteRole} onChange={(event) => setInviteRole(event.target.value as Member["role"])}>
        {roles.map((role) => <option key={role} value={role}>{translate(`members.role.${role}`)}</option>)}
      </select></label>
      <button onClick={async () => {
        const invite = await action<{ token: string }>("create_invite", { workspaceId: workspace.id, role: inviteRole });
        setLink(invite ? `${window.location.origin}/invite/${invite.token}` : null);
        if (!invite) setNote(translate("members.failed"));
      }}>{translate("invite.create")}</button>
      {link && <p><input readOnly value={link} onFocus={(event) => event.target.select()} />
        <button className="secondary" onClick={async () => { await navigator.clipboard.writeText(link); setNote(translate("invite.copied")); }}>{translate("invite.copy")}</button>
        <small> {translate("invite.expires")}</small></p>}
    </div>}
    {note && <p role="status">{note}</p>}
  </section>;
}
