import React from "react";
import { createRoot } from "react-dom/client";
import { translate } from "@weft/shared";
import { QueryClientProvider } from "@tanstack/react-query";
import { registerSW } from "virtual:pwa-register";
import { createQueryClient } from "./query-client";
import "./style.css";

registerSW({ immediate: true });
const queryClient = createQueryClient();

const api = import.meta.env.VITE_API_URL ?? "http://localhost:3000";
type Workspace = { id: string; name: string; slug: string };
type Current = { user: { name: string; email: string }; workspaces: Workspace[]; canCreateWorkspace: boolean };

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

  const workspace = current.workspaces.find((item) => item.slug === currentSlug);
  if (workspace) return <main>
    <header><h1>{workspace.name}</h1><button className="secondary" onClick={() => void signOut()}>{translate("auth.signOut")}</button></header>
    <p>{translate("app.welcome")}</p>
    {current.workspaces.length > 1 && <nav>{current.workspaces.map((item) => <a href={`/${item.slug}`} key={item.id}>{item.name}</a>)}</nav>}
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

createRoot(document.getElementById("root")!).render(<QueryClientProvider client={queryClient}><App /></QueryClientProvider>);
