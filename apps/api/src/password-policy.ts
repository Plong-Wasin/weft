import { createHash } from "node:crypto";
import { APIError } from "better-auth/api";
import { tryGetCurrentAuthEndpointContext } from "@better-auth/core/context";

export type RangeChecker = (prefix: string, signal: AbortSignal) => Promise<string>;

const localList = new Set((await Bun.file(`${import.meta.dir}/../data/10k-most-common-passwords.txt`).text()).split(/\r?\n/).map((word) => word.toLocaleLowerCase("en-US")).filter(Boolean));

export const hibpRangeChecker: RangeChecker = async (prefix, signal) => {
  const response = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, { signal, headers: { "Add-Padding": "true", "User-Agent": "Weft Password Checker" } });
  if (!response.ok) throw new Error("Password range service unavailable");
  return response.text();
};

export function createPasswordPolicy(options: { minimum: number; online: boolean; rangeChecker?: RangeChecker }) {
  const rangeChecker = options.rangeChecker ?? hibpRangeChecker;
  return async function checkPassword(password: string, identityOverride?: { email?: unknown; name?: unknown }) {
    const endpoint = tryGetCurrentAuthEndpointContext();
    const body = (identityOverride ?? endpoint?.body ?? {}) as Record<string, unknown>;
    const refuse = (code: string): never => { throw new APIError("BAD_REQUEST", { code, message: code }); };
    if ([...password].length < options.minimum) refuse("PASSWORD_TOO_SHORT");
    if ([...password].length > 256) refuse("PASSWORD_TOO_LONG");
    const fold = (value: string) => value.normalize("NFKC").toLocaleLowerCase("und");
    const sessionUser = (endpoint?.context as { session?: { user?: { email?: unknown; name?: unknown } } } | undefined)?.session?.user;
    const identity = [body.email ?? sessionUser?.email, body.name ?? sessionUser?.name].filter((value): value is string => typeof value === "string");
    if (identity.some((value) => fold(password) === fold(value))) refuse("PASSWORD_PERSONAL");
    const chars = [...password];
    if (chars.length > 0 && chars.every((char) => char === chars[0])) refuse("PASSWORD_REPEATED");
    let compromised = false;
    if (options.online) {
      const digest = createHash("sha1").update(password, "utf8").digest("hex").toUpperCase();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const response = await Promise.race([rangeChecker(digest.slice(0, 5), controller.signal), new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("Password range service timed out")), 2000); })]);
        const entries = response.trim().split(/\r?\n/);
        if (!response.trim() || entries.some((line) => !/^[A-F0-9]{35}:\d+$/i.test(line))) throw new Error("Invalid password range response");
        compromised = entries.some((line) => {
          const [suffix, count] = line.split(":");
          return suffix?.toUpperCase() === digest.slice(5) && Number(count) > 0;
        });
      } catch {
        compromised = localList.has(fold(password));
      } finally { clearTimeout(timer); if (timeout) clearTimeout(timeout); }
    } else compromised = localList.has(fold(password));
    if (compromised) refuse("PASSWORD_COMPROMISED");
  };
}
