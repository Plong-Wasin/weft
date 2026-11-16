/** Callout icons the editor offers; Written form imports accept only these exact values. */
export const writtenFormCalloutIcons = ["💡", "ℹ️", "⚠️", "✅", "❗", "❤️", "🚀", "🎉"] as const;

/** Schemes accepted by the editor, Markdown converter, preview, and link click handler. */
export const writtenFormLinkSchemes = ["http", "https", "mailto", "tel", "ftp", "ftps", "callto", "sms", "cid", "xmpp"] as const;
const writtenFormLinkSchemeSet = new Set<string>(writtenFormLinkSchemes);
export const compactLinkHref = (value: string) => value.replace(/[\u0000-\u0020\u007f-\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/g, "");
export function isAllowedLinkHref(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const compact = compactLinkHref(value);
  if (/^(?:\/\\|\\\\)/.test(compact)) return false;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(compact)?.[1]?.toLowerCase();
  if (scheme) return writtenFormLinkSchemeSet.has(scheme);
  return !compact.startsWith("//");
}
export function isAllowedLinkScheme(value: string) { return writtenFormLinkSchemeSet.has(value.toLowerCase().replace(/:$/, "")); }

/** Colors allowed by the editor's color guard. */
export function isWrittenFormColor(value: unknown): value is string {
  return typeof value === "string" && (/^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(value) || ["red", "orange", "yellow", "green", "blue", "purple", "gray", "black", "white"].includes(value.toLowerCase()));
}
