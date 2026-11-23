import React from "react";

export type AiState = "unknown" | "on" | "off";

/** Whether the server has AI on (WEFT_AI_ENABLED and a provider key), as reported by /api/config. Unknown until the config arrives. */
let state: AiState = "unknown";
const listeners = new Set<() => void>();

export function setAiEnabled(value: boolean) {
  const next: AiState = value ? "on" : "off";
  if (state === next) return;
  state = next;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }

/** unknown until /api/config answers, then on or off. */
export function useAiState(): AiState {
  return React.useSyncExternalStore(subscribe, () => state, () => state);
}

/** True only when the server reports AI on; every AI surface renders nothing otherwise, including while unknown. */
export function useAiEnabled(): boolean {
  return useAiState() === "on";
}

/** The current value without a component, for code outside React and for tests. */
export function aiEnabledNow(): boolean {
  return state === "on";
}

export function aiStateNow(): AiState {
  return state;
}

/** Wraps one AI surface: it renders its children only while AI is on, so nothing AI shows before the config has loaded or when AI is off. */
export function AiOnly({ children }: { children: React.ReactNode }) {
  return useAiEnabled() ? <>{children}</> : null;
}
