import React from "react";
import { createRoot } from "react-dom/client";
import { translate } from "@weft/shared";
import "./style.css";

const api = import.meta.env.VITE_API_URL ?? "http://localhost:3000";
type Workspace = { id: string; name: string; slug: string };
type Member = { userId: string; name: string; email: string; role: "Admin" | "Member" | "Guest" };
const roles = ["Admin", "Member", "Guest"] as const;
const inviteToken = window.location.pathname.startsWith("/invite/") ? decodeURIComponent(window.location.pathname.split("/")[2] ?? "") : null;

async function action<T>(name: string, body: unknown): Promise<T | null> {
  const response = await fetch(`${api}/actions/${name}`, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return response.ok ? await response.json() as T : null;
}

function MembersPanel({ workspace, self }: { workspace: Workspace; self: string }) {
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
type Current = { user: { id: string; name: string; email: string }; workspaces: Workspace[]; canCreateWorkspace: boolean };

function App() {
  const [current, setCurrent] = React.useState<Current | null>(null);
  const [mode, setMode] = React.useState<"sign-in" | "sign-up">("sign-up");
  const [error, setError] = React.useState<string | null>(null);
  const [name, setName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [workspaceName, setWorkspaceName] = React.useState("");
  const [slug, setSlug] = React.useState("");
  const currentSlug = decodeURIComponent(window.location.pathname.split("/")[1] ?? "");

  async function refresh() {
    const response = await fetch(`${api}/api/me`, { credentials: "include" });
    if (response.ok) {
      const data = await response.json() as Current;
      setCurrent(data);
      if (inviteToken) {
        const joined = await action<{ slug: string }>("accept_invite", { token: inviteToken });
        if (joined) window.location.replace(`/${joined.slug}`); else setError(translate("invite.failed"));
        return;
      }
      if (window.location.pathname === "/" && data.workspaces.length > 0) window.location.replace(`/${data.workspaces[0]!.slug}`);
    }
    else setCurrent(null);
  }
  React.useEffect(() => { void refresh(); }, []);

  async function authenticate(event: React.FormEvent) {
    event.preventDefault(); setError(null);
    const endpoint = mode === "sign-up" ? "sign-up/email" : "sign-in/email";
    const response = await fetch(`${api}/api/auth/${endpoint}`, {
      method: "POST", credentials: "include", headers: { "content-type": "application/json" },
      body: JSON.stringify(mode === "sign-up" ? { name, email, password } : { email, password }),
    });
    if (!response.ok) { setError(translate("auth.failed")); return; }
    await refresh();
  }

  async function createWorkspace(event: React.FormEvent) {
    event.preventDefault(); setError(null);
    const response = await fetch(`${api}/actions/create_workspace`, {
      method: "POST", credentials: "include", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: workspaceName, slug }),
    });
    if (!response.ok) { setError(translate("workspace.createFailed")); return; }
    const workspace = await response.json() as Workspace;
    window.location.assign(`/${workspace.slug}`);
  }

  async function signOut() {
    await fetch(`${api}/api/auth/sign-out`, { method: "POST", credentials: "include" });
    setCurrent(null);
  }

  if (current === null) return <main>
    <h1>{translate("app.title")}</h1><p>{translate("app.welcome")}</p>
    <form onSubmit={authenticate}>
      {mode === "sign-up" && <label>{translate("auth.name")}<input required value={name} onChange={(event) => setName(event.target.value)} /></label>}
      <label>{translate("auth.email")}<input required type="email" value={email} onChange={(event) => setEmail(event.target.value)} /></label>
      <label>{translate("auth.password")}<input required type="password" minLength={8} value={password} onChange={(event) => setPassword(event.target.value)} /></label>
      <button>{translate(mode === "sign-up" ? "auth.signUp" : "auth.signIn")}</button>
    </form>
    <button className="secondary" onClick={() => setMode(mode === "sign-up" ? "sign-in" : "sign-up")}>
      {translate(mode === "sign-up" ? "auth.haveAccount" : "auth.needAccount")}
    </button>
    {error && <p role="alert">{error}</p>}
  </main>;

  if (inviteToken) return <main><p role={error ? "alert" : "status"}>{error ?? translate("invite.joining")}</p></main>;

  const workspace = current.workspaces.find((item) => item.slug === currentSlug);
  if (workspace) return <main>
    <header><h1>{workspace.name}</h1><button className="secondary" onClick={() => void signOut()}>{translate("auth.signOut")}</button></header>
    <p>{translate("app.welcome")}</p>
    {current.workspaces.length > 1 && <label>{translate("workspace.switch")}
      <select value={workspace.slug} onChange={(event) => window.location.assign(`/${event.target.value}`)}>
        {current.workspaces.map((item) => <option value={item.slug} key={item.id}>{item.name}</option>)}
      </select></label>}
    <MembersPanel workspace={workspace} self={current.user.id} />
  </main>;

  const needsFirstWorkspace = current.workspaces.length === 0;
  return <main>
    <header><h1>{needsFirstWorkspace ? translate("workspace.firstTitle") : translate("workspace.yourWorkspaces")}</h1><button className="secondary" onClick={() => void signOut()}>{translate("auth.signOut")}</button></header>
    {current.workspaces.map((item) => <p key={item.id}><a href={`/${item.slug}`}>{item.name}</a></p>)}
    {current.canCreateWorkspace && <form onSubmit={createWorkspace}>
      <label>{translate("workspace.name")}<input required value={workspaceName} onChange={(event) => {
        const value = event.target.value; setWorkspaceName(value);
        if (!slug || slug === slugify(workspaceName)) setSlug(slugify(value));
      }} /></label>
      <label>{translate("workspace.slug")}<input required pattern="[a-z0-9]+(-[a-z0-9]+)*" value={slug} onChange={(event) => setSlug(event.target.value)} /></label>
      <button>{translate("workspace.create")}</button>
    </form>}
    {!current.canCreateWorkspace && <p>{translate("workspace.noAccess")}</p>}
    {error && <p role="alert">{error}</p>}
  </main>;
}

function slugify(value: string) { return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); }

createRoot(document.getElementById("root")!).render(<App />);
