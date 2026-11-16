/** Warnings for settings that are legal but unsafe in production. Returned as lines so a test can read them. */
export function startupWarnings(env: Record<string, string | undefined>): string[] {
  const warnings: string[] = [];
  const hops = Number(env.TRUSTED_PROXY_HOPS ?? 0);
  if (env.NODE_ENV === "production" && (!Number.isFinite(hops) || hops === 0)) {
    warnings.push("TRUSTED_PROXY_HOPS is 0 in production: every caller shares one address, so one person's failed sign-ins lock sign-in for the whole company. Set it to the number of proxies in front of the API (1 behind Caddy).");
  }
  return warnings;
}
