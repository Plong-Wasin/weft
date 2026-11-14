import React from "react";
import { formatDate, translate, type MessageKey } from "@weft/shared";
import { action } from "../../api";
import { Avatar } from "../../avatar";
import { auditFieldLabel, describeAuditValue } from "../../audit-describe";
import { Note, Row, RowList, SettingsBlock, SettingsHeader } from "./settings-ui";
import { auditPageReducer, initialAuditPage, initialMemberTokens, isCurrentRequest, memberTokensReducer, nextRequest } from "./member-security-state";

export type MemberAccount = {
  userId: string; name: string; email: string; role: string; status: "active" | "suspended"; suspendedAt: string | null;
  lastActiveAt: string | null; forcePasswordReset: boolean;
};
type MemberToken = { id: string; name: string; kind: "personal" | "daemon"; prefix: string; createdAt: string; lastUsedAt: string | null; expiresAt: string | null; status: "active" | "expired" | "revoked" };
type AuditRow = { id: string; at: string; actorId: string; actorName: string; kind: string; entityId: string; field: string; oldValue: unknown; newValue: unknown };

export const auditKindKeys = ["agent", "runtime", "trigger", "skill", "workspace", "member", "api_token"] as const;

/** Admin list of people with their status, last activity and the account actions. Agents are not listed here. */
export function MemberSecurityList({ workspaceId, selfId, onChanged }: { workspaceId: string; selfId: string; onChanged: () => Promise<void> }) {
  const [accounts, setAccounts] = React.useState<MemberAccount[] | null>(null);
  const [accountsFailed, setAccountsFailed] = React.useState(false);
  const accountRequest = React.useRef(0);
  const [panel, dispatchPanel] = React.useReducer(memberTokensReducer<MemberToken>, undefined, initialMemberTokens<MemberToken>);
  const panelRef = React.useRef(panel);
  panelRef.current = panel;
  const tokenRequest = React.useRef(0);
  const openTokens = panel.selected;
  const { tokens, failed: tokensFailed } = panel;
  const [note, setNote] = React.useState<string | null>(null);
  const [failed, setFailed] = React.useState(false);
  const load = React.useCallback(async () => {
    const request = nextRequest(accountRequest);
    setAccounts(null); setAccountsFailed(false);
    const result = await action<MemberAccount[]>("list_member_accounts", { workspaceId });
    if (!isCurrentRequest(accountRequest, request)) return;
    setAccounts(result); setAccountsFailed(result === null);
  }, [workspaceId]);
  React.useEffect(() => { void load(); }, [load]);

  const say = (message: string, error = false) => { setNote(message); setFailed(error); };
  const run = async (name: string, body: Record<string, unknown>, done: string, confirmText?: string) => {
    if (confirmText && !window.confirm(confirmText)) return;
    const result = await action(name, { workspaceId, ...body });
    if (result === null) say(translate("account.actionFailed"), true);
    else say(done);
    await load();
    await onChanged();
  };
  const loadTokens = async (userId: string) => {
    const request = nextRequest(tokenRequest);
    dispatchPanel({ type: "load", userId, request });
    const result = await action<MemberToken[]>("list_member_api_tokens", { workspaceId, userId });
    dispatchPanel({ type: "response", userId, request, tokens: result });
  };
  const toggleTokens = async (account: MemberAccount) => {
    if (panelRef.current.selected === account.userId) { dispatchPanel({ type: "load", userId: null, request: nextRequest(tokenRequest) }); return; }
    await loadTokens(account.userId);
  };
  const revokeToken = async (token: MemberToken, account: MemberAccount) => {
    if (!window.confirm(translate("account.revokeTokenConfirm"))) return;
    const result = await action("revoke_member_api_token", { workspaceId, userId: account.userId, tokenId: token.id });
    if (result === null) say(translate("account.actionFailed"), true); else say(translate("account.tokenRevoked"));
    // The panel may now show another member: refresh whoever is selected at this moment.
    const current = panelRef.current.selected;
    if (current) await loadTokens(current);
  };

  if (accounts === null) return <p role="status" className="text-secondary">{translate(accountsFailed ? "account.loadFailed" : "account.loading")}{accountsFailed && <button type="button" className="secondary ml-2" onClick={() => void load()}>{translate("account.retry")}</button>}</p>;
  return <SettingsBlock title={translate("account.adminTitle")} description={translate("account.adminDesc")}>
    <RowList>{accounts.map((account) => {
      const self = account.userId === selfId;
      return <Row key={account.userId}>
        <Avatar name={account.name} id={account.userId} size="md" />
        <span className="grid min-w-0 flex-1 gap-0.5">
          <span className="flex flex-wrap items-center gap-2 font-medium">{account.name}
            <span className={`rounded px-1.5 py-0.5 text-12 ${account.status === "suspended" ? "bg-danger-subtle text-danger-text" : "bg-layer-1 text-secondary"}`}>{translate(account.status === "suspended" ? "account.statusSuspended" : "account.statusActive")}</span>
            {account.forcePasswordReset && <span className="rounded bg-layer-1 px-1.5 py-0.5 text-12 text-secondary">{translate("account.resetPending")}</span>}
          </span>
          <span className="text-13 text-secondary">{account.email} · {translate("account.lastActive")}: {account.lastActiveAt ? formatDate(account.lastActiveAt) : translate("account.never")}</span>
        </span>
        {!self && <>
          {account.status === "suspended"
            ? <button type="button" className="secondary" onClick={() => void run("reactivate_member", { userId: account.userId }, translate("account.reactivated"))}>{translate("account.reactivate")}</button>
            : <button type="button" className="secondary hover:!text-danger-text" onClick={() => void run("suspend_member", { userId: account.userId }, translate("account.suspended"), translate("account.suspendConfirm"))}>{translate("account.suspend")}</button>}
          <button type="button" className="secondary" onClick={() => void run("sign_out_member", { userId: account.userId }, translate("account.signedOutEverywhere"), translate("account.signOutConfirm"))}>{translate("account.signOutEverywhereShort")}</button>
          <button type="button" className="secondary" onClick={() => void run("force_password_reset", { userId: account.userId }, translate("account.resetForced"), translate("account.resetConfirm"))}>{translate("account.forceReset")}</button>
          {account.forcePasswordReset && <button type="button" className="secondary" onClick={() => void run("cancel_forced_password_reset", { userId: account.userId }, translate("account.resetCancelled"), translate("account.cancelResetConfirm"))}>{translate("account.cancelReset")}</button>}
        </>}
        <button type="button" className="secondary" aria-expanded={openTokens === account.userId} onClick={() => void toggleTokens(account)}>{translate("account.tokens")}</button>
        {openTokens === account.userId && <div className="w-full pl-0 pt-2">
          {tokens === null ? <p role="status" className="text-13 text-secondary">{translate(tokensFailed ? "account.loadFailed" : "account.loading")}{tokensFailed && <button type="button" className="secondary ml-2" onClick={() => void loadTokens(account.userId)}>{translate("account.retry")}</button>}</p> : tokens.length === 0 ? <p className="text-13 text-secondary">{translate("account.tokensNone")}</p> : <ul className="m-0 grid list-none gap-1.5 p-0">{tokens.map((token) => <li key={token.id} className="flex flex-wrap items-center gap-3 text-13">
            <span className="min-w-0 flex-1"><span className="font-medium">{token.name}</span> <span className="text-secondary">· {translate(token.kind === "daemon" ? "account.tokenKindDaemon" : "account.tokenKindPersonal")} · {token.prefix}… · {translate(`account.tokenStatus.${token.status}` as MessageKey)}{token.lastUsedAt ? ` · ${translate("account.lastUsed")} ${formatDate(token.lastUsedAt)}` : ""}</span></span>
            {token.status === "active" && <button type="button" className="secondary hover:!text-danger-text" onClick={() => void revokeToken(token, account)}>{translate("account.revokeToken")}</button>}
          </li>)}</ul>}
        </div>}
      </Row>;
    })}</RowList>
    <Note note={note} error={failed} />
  </SettingsBlock>;
}

/** The audit log: who changed what, filtered by person, kind and date, exportable as CSV. Entries are read-only. */
export function AuditLogPage({ workspaceId, members }: { workspaceId: string; members: Array<{ userId: string; name: string }> }) {
  const [person, setPerson] = React.useState("");
  const [kind, setKind] = React.useState("");
  const [from, setFrom] = React.useState("");
  const [to, setTo] = React.useState("");
  const [note, setNote] = React.useState<string | null>(null);
  const [exportFailed, setExportFailed] = React.useState(false);
  const [page, dispatchPage] = React.useReducer(auditPageReducer<AuditRow>, undefined, initialAuditPage<AuditRow>);
  const auditRequest = React.useRef(0);
  const { rows, hasMore, loaded } = page;
  const failed = page.failed || exportFailed;

  const filter = React.useCallback(() => ({
    workspaceId,
    ...(person ? { actorId: person } : {}),
    ...(kind ? { kind } : {}),
    // Dates are the person's local days; the server compares instants.
    ...(from ? { from: new Date(`${from}T00:00:00`).toISOString() } : {}),
    ...(to ? { to: new Date(new Date(`${to}T00:00:00`).getTime() + 86_400_000).toISOString() } : {}),
  }), [workspaceId, person, kind, from, to]);

  const filterKey = JSON.stringify(filter());
  const load = React.useCallback(async (offset: number) => {
    const request = nextRequest(auditRequest);
    if (offset === 0) dispatchPage({ type: "filter", filter: filterKey, request });
    else dispatchPage({ type: "more", request });
    const result = await action<{ rows: AuditRow[]; hasMore: boolean }>("list_audit_log", { ...filter(), limit: 50, offset });
    if (result === null) dispatchPage({ type: "fail", filter: filterKey, request });
    else dispatchPage({ type: "page", filter: filterKey, request, offset, rows: result.rows, hasMore: result.hasMore });
  }, [filter, filterKey]);
  React.useEffect(() => { setNote(null); setExportFailed(false); void load(0); }, [load]);

  const exportCsv = async () => {
    const result = await action<{ csv: string; rows: number; truncated: boolean }>("export_audit_log", filter());
    if (result === null) { setExportFailed(true); setNote(translate("account.actionFailed")); return; }
    const url = URL.createObjectURL(new Blob([result.csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url; link.download = `audit-log-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link); link.click(); link.remove();
    URL.revokeObjectURL(url);
    setExportFailed(false);
    setNote(result.truncated ? translate("account.exportTruncated") : translate("account.exported"));
  };

  const field = "grid gap-1 text-13 font-medium text-secondary";
  return <section>
    <SettingsHeader title={translate("account.auditTitle")} description={translate("account.auditDesc")}>
      <button type="button" className="secondary" onClick={() => void exportCsv()}>{translate("account.exportCsv")}</button>
    </SettingsHeader>
    <div className="mb-4 flex flex-wrap items-end gap-3">
      <label className={field}>{translate("account.filterPerson")}<select value={person} onChange={(event) => setPerson(event.target.value)}>
        <option value="">{translate("account.anyone")}</option>
        {members.map((member) => <option key={member.userId} value={member.userId}>{member.name}</option>)}
      </select></label>
      <label className={field}>{translate("account.filterKind")}<select value={kind} onChange={(event) => setKind(event.target.value)}>
        <option value="">{translate("account.anyKind")}</option>
        {auditKindKeys.map((key) => <option key={key} value={key}>{translate(`account.kind.${key}` as MessageKey)}</option>)}
      </select></label>
      <label className={field}>{translate("account.filterFrom")}<input type="date" value={from} max={to || undefined} onChange={(event) => setFrom(event.target.value)} /></label>
      <label className={field}>{translate("account.filterTo")}<input type="date" value={to} min={from || undefined} onChange={(event) => setTo(event.target.value)} /></label>
    </div>
    {loaded && rows.length === 0 && !failed ? <p className="text-secondary">{translate("account.auditNone")}</p> : null}
    {page.failed && <p role="status" className="text-secondary">{translate("account.loadFailed")}<button type="button" className="secondary ml-2" onClick={() => void load(rows.length)}>{translate("account.retry")}</button></p>}
    {rows.length > 0 && <div className="overflow-x-auto"><table className="w-full min-w-[640px] text-left text-13">
      <thead><tr className="text-secondary"><th className="py-2 pr-3 font-medium">{translate("account.colTime")}</th><th className="py-2 pr-3 font-medium">{translate("account.colPerson")}</th><th className="py-2 pr-3 font-medium">{translate("account.colKind")}</th><th className="py-2 pr-3 font-medium">{translate("account.colChange")}</th><th className="py-2 font-medium">{translate("account.colDetail")}</th></tr></thead>
      <tbody>{rows.map((row) => <tr key={row.id} className="border-t border-subtle align-top">
        <td className="py-2 pr-3 whitespace-nowrap">{formatDate(row.at)}</td>
        <td className="py-2 pr-3">{row.actorName}</td>
        <td className="py-2 pr-3">{translate(`account.kind.${row.kind}` as MessageKey)}</td>
        <td className="py-2 pr-3">{auditFieldLabel(row.field)}</td>
        <td className="py-2 break-all text-secondary">{describeAuditValue(row.newValue ?? row.oldValue)}</td>
      </tr>)}</tbody>
    </table></div>}
    {hasMore && <button type="button" className="secondary mt-3 w-fit" onClick={() => void load(rows.length)}>{translate("account.loadMore")}</button>}
    <Note note={exportFailed ? note : null} error={exportFailed} />
  </section>;
}
