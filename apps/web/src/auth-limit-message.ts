import { translate } from "@weft/shared";

/** The plain-language message for a 429 from sign-in, sign-up or reset (the server names the refusal and the wait), or null for any other answer. */
export function limitMessage(status: number | undefined, body: { code?: unknown; retryAfterSeconds?: unknown } | null | undefined, retryAfterHeader?: string | null): string | null {
  if (status !== 429) return null;
  const seconds = Math.max(1, Math.ceil(Number(body?.retryAfterSeconds ?? retryAfterHeader ?? 60)) || 60);
  const minutes = String(Math.max(1, Math.ceil(seconds / 60)));
  switch (body?.code) {
    case "SIGN_IN_WAIT": return translate("auth.signInWait").replace("{seconds}", String(seconds));
    case "SIGN_IN_LOCKED": return translate("auth.signInLocked").replace("{minutes}", minutes);
    case "SIGN_UP_LIMITED": return translate("auth.signUpLimited").replace("{minutes}", minutes);
    case "PASSWORD_RESET_LIMITED": return translate("auth.resetLimited").replace("{minutes}", minutes);
    default: return translate("auth.tooMany");
  }
}
