export const CLI_VERSION = "1.0.0";

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Parses the first MAJOR.MINOR.PATCH in a string; undefined when there is none. */
export function parseVersion(text: string): [number, number, number] | undefined {
  const match = text.match(/\b(\d+)\.(\d+)\.(\d+)\b/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

export function isNewerVersion(latest: string, current: string) {
  const next = parseVersion(latest);
  const now = parseVersion(current);
  if (!next || !now) return false;
  for (let i = 0; i < 3; i++) if (next[i] !== now[i]) return next[i]! > now[i]!;
  return false;
}

/**
 * Asks the Weft server which CLI version is the newest. Returns a notice only when a newer one exists.
 * Nothing is downloaded or installed; a failed or slow check returns undefined and stays silent.
 */
export async function checkForNewerCli(options: { fetch: FetchLike; apiUrl: string; current?: string; timeoutMs?: number }): Promise<string | undefined> {
  const current = options.current ?? CLI_VERSION;
  try {
    const response = await options.fetch(`${options.apiUrl.replace(/\/$/, "")}/api/cli/version`, { signal: AbortSignal.timeout(options.timeoutMs ?? 3_000) });
    if (!response.ok) return undefined;
    const body = (await response.json()) as { latest?: unknown };
    if (typeof body.latest !== "string" || !isNewerVersion(body.latest, current)) return undefined;
    return `A newer weft CLI is available: ${body.latest} (this one is ${current}). Weft does not update itself. Ask your Weft administrator for the new CLI and install it yourself.`;
  } catch {
    return undefined;
  }
}
