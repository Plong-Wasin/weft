import React from "react";

export type IntegrationsState = "unknown" | "on" | "off";

/** Whether the server has WEFT_INTEGRATIONS_ENABLED on, as reported by /api/config. Unknown until the config arrives. */
let state: IntegrationsState = "unknown";
const listeners = new Set<() => void>();

export function setIntegrationsEnabled(value: boolean) {
  const next: IntegrationsState = value ? "on" : "off";
  if (state === next) return;
  state = next;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }

/** unknown until /api/config answers, then on or off. */
export function useIntegrationsState(): IntegrationsState {
  return React.useSyncExternalStore(subscribe, () => state, () => state);
}

/** True only when the server reports the GitHub/GitLab feature on; hidden UI renders nothing otherwise, including while unknown. */
export function useIntegrationsEnabled(): boolean {
  return useIntegrationsState() === "on";
}

/** The current value without a component, for code outside React and for tests. */
export function integrationsEnabledNow(): boolean {
  return state === "on";
}

export function integrationsStateNow(): IntegrationsState {
  return state;
}
