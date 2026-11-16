/** Presets for a new API token. A preset fills the name and the expiry; Custom leaves both to the person. */
export const tokenPresets = ["mcp", "cli", "custom"] as const;
export type TokenPreset = (typeof tokenPresets)[number];

export const defaultTokenPreset: TokenPreset = "mcp";

/** Days from today until a new token expires, unless the person picks another date. */
export const defaultTokenDays = 30;

const presetNames: Record<TokenPreset, string | null> = { mcp: "MCP", cli: "CLI", custom: null };

/** The name a preset fills in, or null when the preset leaves the name to the person. */
export function presetName(preset: TokenPreset): string | null {
  return presetNames[preset];
}

/** The expiry date (YYYY-MM-DD, local time) a preset fills in, counted from `today`. */
export function presetExpiry(today: Date = new Date()): string {
  const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() + defaultTokenDays);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}
