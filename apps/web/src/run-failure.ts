import { translateDynamic, type Locale } from "@weft/shared";

/** The plain-language reason a Run did not finish, built from the server's failureReason code. Null when there is nothing useful to say. */
export function runFailureText(reason: string | null, locale?: Locale): string | null {
  if (!reason) return null;
  return translateDynamic(`runs.failure.${reason}`, locale) ?? null;
}
