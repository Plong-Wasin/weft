import React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { translate } from "@weft/shared";
import { action } from "../../api";
import { aiPreferencesKey, useAiPreferences, type AiPreferences } from "../../ai-preferences";
import { useAiState } from "../../ai-flag";
import { NotFound } from "../../not-found";
import { Note, SettingsBlock, SettingsHeader } from "./settings-ui";

/** The signed-in person's own preferences that follow the account. Only AI preferences for now, shown only while AI is on. */
export function AccountPreferencesPage() {
  const state = useAiState();
  if (state !== "on") return state === "unknown" ? null : <NotFound />;
  return <AiPreferencesForm />;
}

function AiPreferencesForm() {
  const queryClient = useQueryClient();
  // undefined while loading; null when the request failed.
  const { data, refetch, isFetching } = useAiPreferences();
  const [note, setNote] = React.useState<string | null>(null);
  const [noteError, setNoteError] = React.useState(false);

  async function save(showSelectionMenu: boolean) {
    const saved = await action<AiPreferences>("set_my_ai_preferences", { showSelectionMenu });
    setNoteError(saved === null);
    setNote(translate(saved === null ? "accountPrefs.saveFailed" : "accountPrefs.saved"));
    if (saved) queryClient.setQueryData(aiPreferencesKey, saved);
  }

  return <main className="mx-auto w-full max-w-[900px] px-[var(--padding-page-x)] py-[var(--padding-page-y)]">
    <SettingsHeader title={translate("accountPrefs.title")} description={translate("accountPrefs.description")} />
    {data === null && <div className="flex flex-wrap items-center gap-2">
      <Note note={translate("accountPrefs.loadFailed")} error />
      <button type="button" className="secondary" disabled={isFetching} onClick={() => void refetch()}>{translate("account.retry")}</button>
    </div>}
    {data === undefined && <p role="status" className="text-13 text-secondary">{translate("account.loading")}</p>}
    {data && <SettingsBlock>
      <div className="grid gap-1">
        <label htmlFor="ai-selection-menu" className="flex min-h-11 items-center gap-2 text-14 text-primary">
          <input id="ai-selection-menu" type="checkbox" checked={data.showSelectionMenu} aria-describedby="ai-selection-menu-hint" onChange={(event) => void save(event.target.checked)} />
          <span>{translate("accountPrefs.aiMenu")}</span>
        </label>
        <p id="ai-selection-menu-hint" className="m-0 text-13 text-secondary">{translate("accountPrefs.aiMenuHint")}</p>
      </div>
    </SettingsBlock>}
    {note && <Note note={note} error={noteError} />}
  </main>;
}
