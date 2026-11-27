import { Button } from "@/ui/button";
import React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { translate } from "@weft/shared";
import { action } from "../../api";
import { aiPreferencesKey, useAiPreferences, type AiPreferences } from "../../ai-preferences";
import { useAiState } from "../../ai-flag";
import { useWeekStart, weekStarts, type WeekStart } from "../../week-start";
import { Note, SettingsBlock, SettingsHeader } from "./settings-ui";

import { Checkbox } from "@/ui/checkbox";
/** The signed-in person's own preferences: the week start, kept in this browser, and the AI preferences, which follow the account and show only while AI is on. */
export function AccountPreferencesPage() {
  const state = useAiState();
  return <main className="mx-auto w-full max-w-[900px] px-[var(--padding-page-x)] py-[var(--padding-page-y)]">
    <SettingsHeader title={translate("accountPrefs.title")} description={translate("accountPrefs.description")} />
    <WeekStartSetting />
    {state === "on" && <AiPreferencesForm />}
  </main>;
}

function WeekStartSetting() {
  const [weekStart, setWeekStart] = useWeekStart();
  return <SettingsBlock>
    <div className="grid gap-1">
      <label className="flex min-h-11 flex-wrap items-center gap-2 text-sm text-foreground">
        <span>{translate("accountPrefs.weekStart")}</span>
        <select className="min-h-11" value={weekStart} aria-describedby="week-start-hint" onChange={(event) => setWeekStart(event.target.value as WeekStart)}>
          {weekStarts.map((day) => <option key={day} value={day}>{translate(`accountPrefs.weekStart.${day}`)}</option>)}
        </select>
      </label>
      <p id="week-start-hint" className="m-0 text-sm text-muted-foreground">{translate("accountPrefs.weekStartHint")}</p>
    </div>
  </SettingsBlock>;
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

  return <>
    {data === null && <div className="flex flex-wrap items-center gap-2">
      <Note note={translate("accountPrefs.loadFailed")} error />
      <Button type="button" disabled={isFetching} onClick={() => void refetch()}>{translate("account.retry")}</Button>
    </div>}
    {data === undefined && <p role="status" className="text-sm text-muted-foreground">{translate("account.loading")}</p>}
    {data && <SettingsBlock>
      <div className="grid gap-1">
        <label htmlFor="ai-selection-menu" className="flex min-h-11 items-center gap-2 text-sm text-foreground">
          <Checkbox id="ai-selection-menu" checked={data.showSelectionMenu} aria-describedby="ai-selection-menu-hint" onChange={(event) => void save(event.target.checked)} />
          <span>{translate("accountPrefs.aiMenu")}</span>
        </label>
        <p id="ai-selection-menu-hint" className="m-0 text-sm text-muted-foreground">{translate("accountPrefs.aiMenuHint")}</p>
      </div>
    </SettingsBlock>}
    {note && <Note note={note} error={noteError} />}
  </>;
}
