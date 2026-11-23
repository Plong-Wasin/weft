import React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { translate } from "@weft/shared";
import { action } from "../../api";
import { aiPreferencesKey, useAiPreferences, type AiPreferences } from "../../ai-preferences";
import { useAiState } from "../../ai-flag";
import { Note, SettingsBlock, SettingsHeader } from "./settings-ui";

/** The signed-in person's own preferences that follow the account. Only AI preferences for now, shown only while AI is on. */
export function AccountPreferencesPage() {
  const state = useAiState();
  if (state !== "on") return state === "unknown" ? null : <section className="grid gap-3 p-6"><p role="alert">{translate("app.notFound")}</p></section>;
  return <AiPreferencesForm />;
}

function AiPreferencesForm() {
  const queryClient = useQueryClient();
  // undefined while loading; null when the request failed.
  const { data } = useAiPreferences();
  const [note, setNote] = React.useState<string | null>(null);
  const [noteError, setNoteError] = React.useState(false);

  async function save(showSelectionMenu: boolean) {
    const saved = await action<AiPreferences>("set_my_ai_preferences", { showSelectionMenu });
    setNoteError(saved === null);
    setNote(translate(saved === null ? "accountPrefs.saveFailed" : "accountPrefs.saved"));
    if (saved) queryClient.setQueryData(aiPreferencesKey, saved);
  }

  return <main className="mx-auto w-full max-w-[900px]">
    <SettingsHeader title={translate("accountPrefs.title")} description={translate("accountPrefs.description")} />
    {data === null && <Note note={translate("accountPrefs.loadFailed")} error />}
    {data && <SettingsBlock>
      <div className="flex items-start gap-2">
        <input id="ai-selection-menu" type="checkbox" className="mt-1" checked={data.showSelectionMenu} aria-describedby="ai-selection-menu-hint" onChange={(event) => void save(event.target.checked)} />
        <div className="grid gap-1">
          <label htmlFor="ai-selection-menu" className="text-14 text-primary">{translate("accountPrefs.aiMenu")}</label>
          <p id="ai-selection-menu-hint" className="m-0 text-13 text-secondary">{translate("accountPrefs.aiMenuHint")}</p>
        </div>
      </div>
    </SettingsBlock>}
    {note && <Note note={note} error={noteError} />}
  </main>;
}
