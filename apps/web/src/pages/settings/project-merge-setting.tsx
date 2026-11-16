import React from "react";
import { translate } from "@weft/shared";
import { action } from "../../api";
import { useIntegrationsEnabled } from "../../integrations-flag";
import { SettingsBlock } from "./settings-ui";

/** "When a linked request merges": about pull and merge requests, so it exists only while integrations are on. */
export function ProjectMergeSetting({ projectId, canAdmin, onNote }: { projectId: string; canAdmin: boolean; onNote: (note: string | null) => void }) {
  const enabled = useIntegrationsEnabled();
  const [movesToDone, setMovesToDone] = React.useState(false);
  React.useEffect(() => {
    if (!enabled) return;
    void action<{ movesToDone: boolean }>("get_project_merged_pr_setting", { projectId }).then((result) => setMovesToDone(result?.movesToDone === true));
  }, [projectId, enabled]);
  if (!enabled) return null;
  return <SettingsBlock title={translate("projectMerge.title")} description={translate("projectMerge.desc")}>
    <label className="flex items-center gap-2"><input type="checkbox" role="switch" disabled={!canAdmin} checked={movesToDone} onChange={async (event) => {
      const result = await action<{ movesToDone: boolean }>("set_project_merged_pr_setting", { projectId, movesToDone: event.target.checked });
      if (result) setMovesToDone(result.movesToDone);
      onNote(result === null ? translate("projectMerge.failed") : null);
    }} />{translate("projectMerge.toggle")}</label>
  </SettingsBlock>;
}
