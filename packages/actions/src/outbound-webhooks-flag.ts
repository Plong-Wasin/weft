/**
 * Outbound webhooks ship off. Only the exact value "true" turns them on; unset or anything else means off.
 * When off: the webhook Actions are not registered (so not on REST, the CLI, MCP or the AI), no event is recorded,
 * no delivery job is handled, the web app hides the settings page, and nothing is written or sent.
 */
export const outboundWebhooksFlagName = "WEFT_OUTBOUND_WEBHOOKS_ENABLED";

/** Operator opt-in for receivers on private, loopback or link-local addresses. Off by default; only the exact value "true" turns it on. */
export const outboundWebhooksAllowPrivateFlagName = "WEFT_OUTBOUND_WEBHOOKS_ALLOW_PRIVATE_NETWORKS";

export function outboundWebhooksEnabled(env: Record<string, string | undefined> = Bun.env): boolean {
  return env[outboundWebhooksFlagName] === "true";
}

export function outboundWebhooksAllowPrivateNetworks(env: Record<string, string | undefined> = Bun.env): boolean {
  return env[outboundWebhooksAllowPrivateFlagName] === "true";
}

/** Operator list of extra ports a webhook may use (comma separated), added to the defaults. Unreadable entries are ignored. */
export const outboundWebhooksAllowPortsFlagName = "WEFT_OUTBOUND_WEBHOOKS_ALLOW_PORTS";
export const defaultWebhookPorts = [80, 443, 8443];

export function allowedWebhookPorts(env: Record<string, string | undefined> = Bun.env): number[] {
  const extra = (env[outboundWebhooksAllowPortsFlagName] ?? "").split(",").map((entry) => entry.trim()).filter((entry) => /^\d{1,5}$/.test(entry)).map(Number).filter((port) => port >= 1 && port <= 65535);
  return [...new Set([...defaultWebhookPorts, ...extra])];
}
