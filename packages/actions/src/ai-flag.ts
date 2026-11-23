/**
 * Provider-key AI is on by default. Only the exact value "false" switches it off; unset or anything else leaves it on.
 * AI also counts as off when the server has no API key for its configured provider (AI_PROVIDER, default openai).
 * The two causes stay distinct so the config endpoint and the AI settings page can say which one applies.
 */
export const aiFlagName = "WEFT_AI_ENABLED";

export type AiOffReason = "switched_off" | "no_provider_key";
export type AiState = { enabled: true; reason: null } | { enabled: false; reason: AiOffReason };

export function aiState(env: Record<string, string | undefined> = Bun.env): AiState {
  if (env[aiFlagName] === "false") return { enabled: false, reason: "switched_off" };
  const provider = (env.AI_PROVIDER ?? "openai").toLowerCase();
  const keyName = provider === "openai" ? "OPENAI_API_KEY" : provider === "anthropic" ? "ANTHROPIC_API_KEY" : null;
  if (!keyName || !env[keyName]?.trim()) return { enabled: false, reason: "no_provider_key" };
  return { enabled: true, reason: null };
}

export function aiEnabled(env: Record<string, string | undefined> = Bun.env): boolean {
  return aiState(env).enabled;
}
