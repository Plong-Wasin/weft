import React from "react";
import { translate } from "@weft/shared";
import { action, actionResult } from "../../api";
import { useWorkspace } from "../../layouts/workspace-layout";
import { Note, Row, RowList, SettingsBlock, SettingsHeader } from "./settings-ui";

type Runtime = { id: string; workspaceId: string; ownerId: string; ownerName: string; hostname: string; agentCli: "claude" | "codex"; shared: boolean; online: boolean; lastSeenAt: string };

export function WorkspaceRuntimes() {
  const { workspace, selfId } = useWorkspace();
  const [runtimes, setRuntimes] = React.useState<Runtime[]>([]);
  const [failed, setFailed] = React.useState(false);
  const load = React.useCallback(async () => {
    const result = await action<Runtime[]>("list_runtimes", { workspaceId: workspace.id });
    setFailed(result === null);
    setRuntimes(result ?? []);
  }, [workspace.id]);
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
      {runtimes.length === 0 ? <p className="text-14 text-secondary">{translate("runtimes.empty")}</p> : <RowList>
        {runtimes.map((runtime) => <Row key={runtime.id}><div className="mr-auto grid gap-0.5"><span className="font-medium">{runtime.ownerName} · {runtime.agentCli}</span><span className="text-13 text-secondary">{runtime.hostname} · {translate(runtime.online ? "runtimes.online" : "runtimes.offline")}</span></div>
          <span className="text-13 text-secondary">{runtime.shared ? translate("runtimes.shared") : translate("runtimes.private")}</span>
          {runtime.ownerId === selfId && <button type="button" className="secondary" onClick={() => void toggle(runtime)}>{translate(runtime.shared ? "runtimes.unshare" : "runtimes.share")}</button>}
        </Row>)}
      </RowList>}
    </SettingsBlock>
  </>;
}
