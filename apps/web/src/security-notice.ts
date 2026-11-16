import { translate, type Locale } from "@weft/shared";

/** The server stores "notice:<code>" with an optional reason on the next line. Older rows hold a finished English sentence, which is shown as it is. */
export function securityNoticeText(raw: string, locale?: Locale): string {
  const match = /^notice:([a-z_]+)(?:\n([\s\S]*))?$/.exec(raw);
  if (!match) return raw;
  const base = match[1] === "signed_out" ? translate("account.notice.signed_out", locale) : match[1] === "password_reset" ? translate("account.notice.password_reset", locale) : null;
  if (base === null) return translate("account.notice.generic", locale);
  const reason = match[2]?.trim();
  return reason ? `${translate("account.noticeReason", locale).replace("{reason}", reason)} ${base}` : base;
}
