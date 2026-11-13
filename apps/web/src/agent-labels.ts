import { translate, type Locale } from "@weft/shared";

/** The computer and coding tool of a shared Runtime. The server sends them as separate fields; an older reply is parsed defensively out of the combined text. */
export function runtimeParts(agent: { runtimeName: string | null; runtimeHostname?: string | null; runtimeCli?: string | null }): { computer: string; tool: string | null } | null {
  if (!agent.runtimeName && !agent.runtimeHostname) return null;
  if (agent.runtimeHostname) return { computer: agent.runtimeHostname, tool: agent.runtimeCli ?? null };
  const name = agent.runtimeName!;
  const at = name.lastIndexOf(" · ");
  return at < 0 ? { computer: name, tool: null } : { computer: name.slice(0, at), tool: name.slice(at + 3) };
}

export const capitalize = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

/** Profile words for an Agent on a Runtime: with no profile chosen it says only "Default", never a made-up access level. */
export function profileSummary(profile: { runtimeProfileName: string | null; runtimeProfileSandbox: string | null }, locale?: Locale): string[] {
  if (!profile.runtimeProfileName) return [translate("agents.profileDefault", locale)];
  return [translate("agents.metaPermissions", locale).replace("{name}", profile.runtimeProfileName), translate(profile.runtimeProfileSandbox === "full" ? "runtimes.fullAccessWarning" : "runtimes.sandboxEnabled", locale)];
}
