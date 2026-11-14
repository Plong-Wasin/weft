import React from "react";

/** Whether the server has WEFT_OUTBOUND_WEBHOOKS_ENABLED on, as reported by /api/config. Off until the config arrives. */
let enabled = false;
const listeners = new Set<() => void>();

export function setOutboundWebhooksEnabled(value: boolean) {
  if (enabled === value) return;
  enabled = value;
  listeners.forEach((listener) => listener());
}

/** True only when the server reports outbound webhooks on; hidden UI renders nothing when false. */
export function useOutboundWebhooksEnabled(): boolean {
  return React.useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => enabled, () => false);
}

/** The current value without a component, for code outside React and for tests. */
export function outboundWebhooksEnabledNow(): boolean {
  return enabled;
}
