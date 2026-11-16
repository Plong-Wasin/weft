import { translate, type Locale } from "@weft/shared";

export type AccessInfo = { isAgent?: boolean; hasAccess?: boolean; accessReason?: string | null; accessAsk?: "owner" | "admin" | null; accessOwnerName?: string | null };

/** Why a greyed-out Agent cannot be picked, in the viewer's language. The server sends who to ask; the older English accessReason is only a fallback. */
export function accessReasonText(person: AccessInfo, locale?: Locale): string | null {
  if (!person.isAgent || person.hasAccess) return null;
  if (person.accessAsk === "owner" && person.accessOwnerName) return translate("agents.askableAsk", locale).replace("{name}", person.accessOwnerName);
  if (person.accessAsk === "owner") return translate("agents.askableAskOwner", locale);
  if (person.accessAsk === "admin") return translate("agents.askableAskAdmin", locale);
  return person.accessReason ?? null;
}
