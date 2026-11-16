import React from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { translate } from "@weft/shared";
import { copyText } from "../../toast";
import { action, api } from "../../api";
import { useWorkspace } from "../../layouts/workspace-layout";
import { paths } from "../../routes";
import { Note, SettingsBlock, SettingsHeader } from "./settings-ui";

const clients = [
  { id: "claude-code", label: "Claude Code" },
  { id: "claude-desktop", label: "Claude Desktop" },
  { id: "cursor", label: "Cursor" },
  { id: "codex", label: "Codex" },
] as const;
type ClientId = (typeof clients)[number]["id"];

/** The MCP endpoint is served under the public origin (docs/mcp.md). */
export function mcpEndpoint(publicUrl: string) {
  return `${publicUrl}/mcp`;
}

/** Default setup per client: HTTP with OAuth, so no token is pasted. */
export function mcpSnippets(publicUrl: string): Record<ClientId, string> {
  const endpoint = mcpEndpoint(publicUrl);
  return {
    "claude-code": `claude mcp add --transport http weft ${endpoint}`,
    "claude-desktop": JSON.stringify({ mcpServers: { weft: { command: "npx", args: ["-y", "mcp-remote", endpoint] } } }, null, 2),
    cursor: JSON.stringify({ mcpServers: { weft: { url: endpoint } } }, null, 2),
    codex: `codex mcp add weft --url ${endpoint}\ncodex mcp login weft`,
  };
}

/** Advanced setup: a local stdio server, or HTTP with a Personal API token the user creates. */
export function advancedSnippets(publicUrl: string) {
  return {
    stdio: JSON.stringify({ mcpServers: { weft: { command: "bun", args: ["/path/to/weft/apps/mcp/src/index.ts"], env: { WEFT_API_URL: publicUrl, WEFT_TOKEN: "<your-token>" } } } }, null, 2),
    token: JSON.stringify({ mcpServers: { weft: { url: mcpEndpoint(publicUrl), headers: { Authorization: "Bearer <your-token>" } } } }, null, 2),
  };
}

/** The public repository the CLI is cloned from. */
export const cliRepositoryUrl = "https://github.com/Plong-Wasin/weft.git";

/** The clone folder used when the field is empty. */
export const defaultClonePath = "~/weft";

/** Copyable CLI steps, with the clone path filled in. The CLI runs from the checkout with Bun; nothing is published. */
export function cliSteps(clonePath: string, serverUrl: string) {
  const folder = clonePath.trim() || defaultClonePath;
  return [
    { id: "clone", label: translate("connectAi.stepClone"), command: `git clone ${cliRepositoryUrl} ${folder}` },
    { id: "install", label: translate("connectAi.stepInstall"), command: `cd ${folder} && bun install` },
    { id: "alias", label: translate("connectAi.stepAlias"), command: `alias weft="bun ${folder}/apps/cli/src/index.ts"` },
    { id: "login", label: translate("connectAi.stepLogin"), command: `weft login --api-url ${serverUrl}` },
    { id: "start", label: translate("connectAi.stepStart"), command: "weft daemon start" },
    { id: "probe", label: translate("connectAi.stepProbe"), command: "weft daemon probe" },
  ];
}

/** The address the CLI signs in to: the public origin when set, otherwise the API address this page talks to. The CLI defaults to localhost, so the steps always pass it. */
export function cliServerUrl(publicUrl: string | null) {
  if (publicUrl !== null) return publicUrl;
  return api ? new URL(api, location.href).origin : location.origin;
}

/** The guide prompt an AI assistant follows. It holds the address and steps, never a token. The MCP part needs a public address; the CLI part does not. */
export function guidePrompt(publicUrl: string | null, serverUrl: string) {
  const lines = [`I want to connect you to my Weft workspace. The Weft server is ${serverUrl}. Do the parts below that fit your client, in order.`, ""];
  if (publicUrl !== null) {
    const endpoint = mcpEndpoint(publicUrl);
    lines.push(
      `A. MCP (an AI client that talks to Weft). The MCP endpoint is ${endpoint}.`,
      `1. Add the MCP server ${endpoint} over HTTP in your client. Claude Code: claude mcp add --transport http weft ${endpoint}. Codex: codex mcp add weft --url ${endpoint}, then codex mcp login weft. Other clients: enter the URL in their remote MCP settings.`,
      "2. Sign in when the client opens the Weft sign-in page (OAuth). You do not need a token for this.",
      `3. If your client cannot use OAuth, stop and ask me. Do not ask me to paste a token into this chat. I will create a Personal API token myself on the API tokens page at ${serverUrl}${paths.apiTokens()} and configure the client with it.`,
      "4. Check the connection by listing the projects of my workspace with the Weft tools, then tell me the result.",
      "",
    );
  }
  lines.push(
    `${publicUrl !== null ? "B" : "A"}. CLI and Daemon (my computer runs agents for Weft). The CLI is in the public repository ${cliRepositoryUrl}; Bun must be installed.`,
    `1. Clone it and install: git clone ${cliRepositoryUrl} ${defaultClonePath} && cd ${defaultClonePath} && bun install`,
    `2. Make an alias: alias weft="bun ${defaultClonePath}/apps/cli/src/index.ts"`,
    `3. Sign in with the server address, because the CLI defaults to localhost: weft login --api-url ${serverUrl}. This opens a browser for me; do not ask me for a password or a token.`,
    "4. Start the Daemon: weft daemon start. If an agent CLI is not found, run weft daemon probe and tell me what it says.",
    "5. Tell me when Settings > Connect AI shows my computer as connected.",
  );
  return lines.join("\n");
}

type CliRuntime = { id: string; ownerId: string; hostname: string; agentCli: string; online: boolean };

/** Polls the workspace Runtimes every few seconds and lists the ones this person registered. */
function CliRuntimeCard({ publicUrl }: { publicUrl: string | null }) {
  const { workspace, selfId } = useWorkspace();
  const [clonePath, setClonePath] = React.useState("");
  const runtimes = useQuery({
    queryKey: ["connect-ai-runtimes", workspace.id],
    queryFn: () => action<CliRuntime[]>("list_runtimes", { workspaceId: workspace.id }),
    refetchInterval: 3000,
    retry: false,
  });
  // Registered is not connected: a Runtime whose Daemon stopped stays listed but offline, so only online ones count.
  const mine = (runtimes.data ?? []).filter((runtime) => runtime.ownerId === selfId && runtime.online);
  return <SettingsBlock title={translate("connectAi.cliTitle")} description={translate("connectAi.cliDescription")}>
    <div aria-live="polite" className="grid gap-1 rounded-md border border-subtle p-3">
      {mine.length > 0 ? mine.map((runtime) => <p key={runtime.id} className="m-0 text-14 font-medium text-primary">
        {translate("connectAi.cliConnected").replace("{hostname}", runtime.hostname).replace("{agentCli}", runtime.agentCli)}
      </p>) : <>
        <p className="m-0 text-14 font-medium text-primary">{translate("connectAi.cliWaiting")}</p>
        <p className="m-0 text-13 text-secondary">{translate("connectAi.cliWaitingHelp")}</p>
      </>}
    </div>
    <label className="grid gap-1 text-13 font-medium text-primary">{translate("connectAi.clonePathLabel")}
      <input value={clonePath} placeholder={defaultClonePath} onChange={(event) => setClonePath(event.target.value)} className="font-mono" />
    </label>
    <p className="m-0 text-13 text-secondary">{translate("connectAi.clonePathHelp")}</p>
    <ol className="m-0 grid list-none gap-4 p-0">
      {cliSteps(clonePath, cliServerUrl(publicUrl)).map((step) => <li key={step.id} className="grid gap-2">
        <h3 className="m-0 text-14 font-medium text-primary">{step.label}</h3>
        <CopyBlock text={step.command} label={step.label} />
      </li>)}
    </ol>
  </SettingsBlock>;
}

async function fetchPublicUrl(): Promise<string | null> {
  const response = await fetch(`${api}/api/mcp/address`);
  if (!response.ok) throw new Error(String(response.status));
  return ((await response.json()) as { publicUrl: string | null }).publicUrl;
}

function CopyBlock({ text, label }: { text: string; label: string }) {
  return <div className="grid gap-2">
    <pre aria-label={label} className="m-0 overflow-x-auto rounded-md border border-subtle bg-layer-1 p-3 font-mono text-12 text-primary">{text}</pre>
    <button type="button" className="secondary justify-self-start" onClick={() => void copyText(text, translate("connectAi.copied"), translate("connectAi.copyFailed"))}>{translate("connectAi.copy")}</button>
  </div>;
}

function McpCard({ publicUrl }: { publicUrl: string | null }) {
  const [client, setClient] = React.useState<ClientId>("claude-code");
  const selected = clients.find((item) => item.id === client)!;
  return <SettingsBlock title={translate("connectAi.mcpTitle")} description={translate("connectAi.mcpDescription")}>
    {publicUrl === null ? <Note note={translate("connectAi.notReady")} /> : <>
      <div role="tablist" aria-label={translate("connectAi.clientsLabel")} className="flex flex-wrap gap-1">
        {clients.map((item) => <button key={item.id} type="button" role="tab" id={`mcp-tab-${item.id}`} aria-selected={client === item.id} aria-controls="mcp-client-panel" onClick={() => setClient(item.id)}
          className={`rounded-md px-3 py-1.5 text-13 ${client === item.id ? "bg-accent-subtle text-accent-text" : "text-secondary hover:bg-layer-2"}`}>{item.label}</button>)}
      </div>
      <div role="tabpanel" id="mcp-client-panel" aria-labelledby={`mcp-tab-${client}`} className="grid gap-2">
        <CopyBlock text={mcpSnippets(publicUrl)[client]} label={selected.label} />
        <p className="m-0 text-13 text-secondary">{translate("connectAi.oauthHelp")}</p>
      </div>
      <details className="grid gap-3 rounded-md border border-subtle p-3">
        <summary className="cursor-pointer text-14 font-medium text-primary">{translate("connectAi.advanced")}</summary>
        <p className="m-0 text-13 text-secondary">{translate("connectAi.advancedHelp")}</p>
        <h3 className="m-0 text-13 font-medium text-primary">{translate("connectAi.stdioTitle")}</h3>
        <CopyBlock text={advancedSnippets(publicUrl).stdio} label={translate("connectAi.stdioTitle")} />
        <h3 className="m-0 text-13 font-medium text-primary">{translate("connectAi.tokenTitle")}</h3>
        <CopyBlock text={advancedSnippets(publicUrl).token} label={translate("connectAi.tokenTitle")} />
        <Link to={paths.apiTokens()} className="text-13 text-accent-text underline">{translate("connectAi.tokensLink")}</Link>
      </details>
    </>}
  </SettingsBlock>;
}

function GuideCard({ publicUrl }: { publicUrl: string | null }) {
  return <SettingsBlock title={translate("connectAi.guideTitle")} description={translate("connectAi.guideDescription")}>
    <button type="button" className="secondary justify-self-start" onClick={() => { void copyText(guidePrompt(publicUrl, cliServerUrl(publicUrl)), translate("connectAi.copied"), translate("connectAi.copyFailed")); }}>{translate("connectAi.copyGuide")}</button>
  </SettingsBlock>;
}

export function ConnectAiSettings() {
  const address = useQuery({ queryKey: ["mcp-public-address"], queryFn: fetchPublicUrl, retry: false });
  return <section>
    <SettingsHeader title={translate("connectAi.title")} description={translate("connectAi.description")} />
    {address.isError && <Note note={translate("connectAi.loadFailed")} error />}
    {address.isSuccess && <McpCard publicUrl={address.data} />}
    {(address.isSuccess || address.isError) && <CliRuntimeCard publicUrl={address.isSuccess ? address.data : null} />}
    {address.isSuccess && <GuideCard publicUrl={address.data} />}
  </section>;
}
