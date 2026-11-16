import React from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { translate } from "@weft/shared";
import { copyText } from "../../toast";
import { api } from "../../api";
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

/** The guide prompt an AI assistant follows. It holds the address and steps, never a token. */
export function guidePrompt(publicUrl: string) {
  const endpoint = mcpEndpoint(publicUrl);
  return [
    `I want to connect you to my Weft workspace through MCP. The Weft server is ${publicUrl}, and its MCP endpoint is ${endpoint}.`,
    "",
    "Set it up in this order:",
    `1. Add the MCP server ${endpoint} over HTTP in your client. Claude Code: claude mcp add --transport http weft ${endpoint}. Codex: codex mcp add weft --url ${endpoint}, then codex mcp login weft. Other clients: enter the URL in their remote MCP server settings.`,
    "2. Sign in when the client opens the Weft sign-in page (OAuth). You do not need a token for this.",
    `3. If your client cannot use OAuth, stop and ask me. Do not ask me to paste a token into this chat. I will create a Personal API token myself on the API tokens page at ${publicUrl}${paths.apiTokens()} and configure the client with it.`,
    "4. Check the connection by listing the projects of my workspace with the Weft tools, then tell me the result.",
  ].join("\n");
}

async function fetchPublicUrl(): Promise<string | null> {
  const response = await fetch(`${api}/api/mcp/address`, { credentials: "include" });
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
    <button type="button" className="secondary justify-self-start" disabled={publicUrl === null} onClick={() => { if (publicUrl !== null) void copyText(guidePrompt(publicUrl), translate("connectAi.copied"), translate("connectAi.copyFailed")); }}>{translate("connectAi.copyGuide")}</button>
  </SettingsBlock>;
}

export function ConnectAiSettings() {
  const address = useQuery({ queryKey: ["mcp-public-address"], queryFn: fetchPublicUrl, retry: false });
  return <section>
    <SettingsHeader title={translate("connectAi.title")} description={translate("connectAi.description")} />
    {address.isError && <Note note={translate("connectAi.loadFailed")} error />}
    {address.isSuccess && <>
      <McpCard publicUrl={address.data} />
      <GuideCard publicUrl={address.data} />
    </>}
  </section>;
}
