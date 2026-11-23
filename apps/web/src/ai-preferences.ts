import { useQuery } from "@tanstack/react-query";
import { action } from "./api";

export type AiPreferences = { showSelectionMenu: boolean };

export const aiPreferencesKey = ["my-ai-preferences"] as const;

/** The signed-in person's AI preferences, loaded once and kept in the query cache. */
export function useAiPreferences() {
  return useQuery({ queryKey: aiPreferencesKey, queryFn: () => action<AiPreferences>("get_my_ai_preferences", {}), staleTime: 60_000 });
}

/** Whether the floating AI menu shows on text selection. On by default: it stays on until the preference loads, and when it cannot load. */
export function useShowAiSelectionMenu(): boolean {
  const { data } = useAiPreferences();
  return data?.showSelectionMenu !== false;
}
