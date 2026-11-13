import React from "react";
import { translate } from "@weft/shared";
import { action, api, webhookUrl } from "../../api";
import { copyText } from "../../toast";
import { useWorkspace } from "../../layouts/workspace-layout";
import { Navigate } from "react-router";
import { useIntegrationsState } from "../../integrations-flag";
import { useWorkspaceMembers } from "./workspace-settings";
import { Note, Row, RowList, SettingsBlock, SettingsHeader } from "./settings-ui";

type Integration = { id: string; provider: "github" | "gitlab"; enabled: boolean; repositories: string[]; webhookPath: string; createdAt: string };
type Created = { id: string; provider: string; enabled: boolean; webhookPath: string; secret: string };

const providers = ["github", "gitlab"] as const;
/** owner/name for GitHub, group/project (groups may nest) for GitLab. */
/** A format example for the input, not user-facing text, so it is not translated. */
const repositoryExample = ["acme", "app"].join("/");
const repositoryLine = /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)+$/;
/** Product names stay as written in every language. */
const providerName = (provider: string) => (provider === "github" ? "GitHub" : "GitLab");

/** One provider's connection: on/off, its webhook URL and secret, and the repositories it may link. */
function Connection({ provider, row, secret, onChanged, onSecret, say }: { provider: (typeof providers)[number]; row: Integration; secret: string | null; onChanged: () => Promise<void>; onSecret: (value: string | null) => void; say: (message: string | null, error?: boolean) => void }) {
  const [draft, setDraft] = React.useState(row.repositories.join("\n"));
  const url = webhookUrl(api, row.webhookPath);
  const setup = translate(provider === "github" ? "integrations.setupGithub" : "integrations.setupGitlab");
  return <SettingsBlock title={providerName(provider)}>
    <label className="flex items-center gap-2"><input type="checkbox" checked={row.enabled} onChange={async (event) => {
      const result = await action("update_work_item_integration", { integrationId: row.id, enabled: event.target.checked });
      say(result === null ? translate("integrations.failed") : null, result === null);
      await onChanged();
    }} />{translate("integrations.enabled")}</label>
    <p className="m-0 text-13 text-secondary">{translate("integrations.enabledDesc")}</p>
    <label className="grid gap-1 text-13 text-secondary">{translate("integrations.webhookUrl")}
      <input readOnly value={url} onFocus={(event) => event.target.select()} className="bg-layer-1" />
    </label>
    <p className="m-0 text-13 text-secondary">{translate("integrations.webhookUrlHelp")}</p>
    <p className="m-0 text-13 text-secondary">{setup}</p>
    {secret && <div className="grid gap-2 rounded-lg border border-subtle p-3">
      <span className="text-14 font-medium">{translate("integrations.secretTitle")}</span>
      <p className="m-0 text-13 text-secondary">{translate("integrations.secretHelp")}</p>
      <p className="m-0 text-13 text-secondary">{translate("integrations.secretOnce")}</p>
      <div className="flex flex-wrap items-center gap-2">
        <input readOnly value={secret} aria-label={translate("integrations.secretTitle")} onFocus={(event) => event.target.select()} className="min-w-0 flex-1 bg-layer-1" />
        <button type="button" className="secondary" onClick={async () => { if (await copyText(secret, translate("integrations.secretCopied"), translate("comments.copyFailed"))) say(translate("integrations.secretCopied")); }}>{translate("integrations.copySecret")}</button>
      </div>
    </div>}
    <button type="button" className="secondary w-fit" onClick={async () => {
      if (!window.confirm(translate("integrations.rotateConfirm"))) return;
      const result = await action<{ secret: string }>("rotate_work_item_integration_secret", { integrationId: row.id });
      if (!result) { say(translate("integrations.failed"), true); return; }
      onSecret(result.secret);
      say(null);
    }}>{translate("integrations.rotate")}</button>
    <label className="grid gap-1 text-13 text-secondary">{translate("integrations.repositories")}
      <textarea rows={4} value={draft} placeholder={repositoryExample} onChange={(event) => setDraft(event.target.value)} />
    </label>
    <p className="m-0 text-13 text-secondary">{translate("integrations.repositoriesDesc")}</p>
    <button type="button" className="secondary w-fit" onClick={async () => {
      const lines = draft.split("\n").map((line) => line.trim()).filter(Boolean);
      if (lines.some((line) => !repositoryLine.test(line))) { say(translate("integrations.invalidRepository"), true); return; }
      const result = await action("update_work_item_integration", { integrationId: row.id, repositories: lines });
      say(result === null ? translate("integrations.failed") : translate("integrations.saved"), result === null);
      await onChanged();
    }}>{translate("integrations.saveRepositories")}</button>
  </SettingsBlock>;
}

/** Workspace Admin page that connects GitHub or GitLab. Nothing is linked until a connection is turned on. */
export function WorkspaceIntegrations() {
  const { workspace } = useWorkspace();
  const { isAdmin, adminLoading } = useWorkspaceMembers();
  const [rows, setRows] = React.useState<Integration[] | null>(null);
  const [loaded, setLoaded] = React.useState(false);
  const [secrets, setSecrets] = React.useState<Partial<Record<string, string>>>({});
  const [note, setNote] = React.useState<string | null>(null);
  const [failed, setFailed] = React.useState(false);
  const say = (message: string | null, error = false) => { setNote(message); setFailed(error); };
  const load = React.useCallback(async () => {
    setRows(await action<Integration[]>("list_work_item_integrations", { workspaceId: workspace.id }));
    setLoaded(true);
  }, [workspace.id]);
  React.useEffect(() => { void load(); }, [load]);

  if (adminLoading || (loaded && rows === null)) return <section>
    <SettingsHeader title={translate("integrations.title")} description={translate("integrations.desc")} />
    {!adminLoading && !isAdmin && <p role="status" className="text-secondary">{translate("integrations.adminOnly")}</p>}
    {!adminLoading && isAdmin && <p role="status" className="text-secondary">{translate("integrations.failed")}</p>}
  </section>;

  return <section>
    <SettingsHeader title={translate("integrations.title")} description={translate("integrations.desc")} />
    {providers.map((provider) => {
      const row = rows?.find((candidate) => candidate.provider === provider);
      if (!row) return <SettingsBlock key={provider} title={providerName(provider)}>
        <RowList><Row><span className="flex-1 text-secondary">{translate("integrations.notConnected")}</span>
          <button type="button" onClick={async () => {
            const created = await action<Created>("create_work_item_integration", { workspaceId: workspace.id, provider });
            if (!created) { say(translate("integrations.connectFailed"), true); return; }
            setSecrets((current) => ({ ...current, [provider]: created.secret }));
            say(null);
            await load();
          }}>{translate("integrations.connect").replace("{provider}", providerName(provider))}</button>
        </Row></RowList>
      </SettingsBlock>;
      return <Connection key={`${provider}-${row.id}`} provider={provider} row={row} secret={secrets[provider] ?? null} say={say}
        onSecret={(value) => setSecrets((current) => ({ ...current, [provider]: value ?? undefined }))} onChanged={load} />;
    })}
    <Note note={note} error={failed} />
  </section>;
}

/** The route is reachable only while WEFT_INTEGRATIONS_ENABLED is on; it renders nothing until /api/config has answered, then sends the visitor to General settings when it is off. */
export function IntegrationsRoute() {
  const state = useIntegrationsState();
  if (state === "unknown") return null;
  return state === "on" ? <WorkspaceIntegrations /> : <Navigate to="../" replace />;
}
