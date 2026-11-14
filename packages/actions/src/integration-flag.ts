/**
 * GitHub and GitLab links ship off. Only the exact value "true" turns them on; unset or anything else means off.
 * When off: the webhook routes answer 404 without doing any work, the integration Actions are not registered (so not
 * on REST, the CLI, MCP or the AI), the web app hides the settings page and the work item section, and nothing is written.
 */
export const integrationsFlagName = "WEFT_INTEGRATIONS_ENABLED";

export function integrationsEnabled(env: Record<string, string | undefined> = Bun.env): boolean {
  return env[integrationsFlagName] === "true";
}
