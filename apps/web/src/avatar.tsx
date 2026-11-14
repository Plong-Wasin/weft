import React from "react";
import { Bot, User } from "lucide-react";
import { translate } from "@weft/shared";

/**
 * The one Avatar for people and Agents. A person is a round Avatar with a stable colour and the first
 * letter of the name; an Agent is a rounded square with a bot mark. A profile picture wins when one exists
 * and loads; otherwise the letter (or a person icon for an empty name) is shown.
 */

/** Eight colours with white text at WCAG AA contrast (4.5:1 or better). Same in light and dark themes. */
export const AVATAR_PALETTE = ["#1d4ed8", "#0f766e", "#6d28d9", "#be123c", "#b45309", "#047857", "#a21caf", "#c2410c"] as const;

/** Leading Thai vowels that are letters but must not be the initial (เ แ โ ใ ไ). */
const SKIPPED_LEADING = new Set(["เ", "แ", "โ", "ใ", "ไ"]);
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/** The first letter or digit of a name, uppercased. Emoji, symbols and leading Thai vowels are skipped. Null when none. */
export function avatarLetter(name: string | null | undefined): string | null {
  for (const character of (name ?? "").trim()) {
    if (SKIPPED_LEADING.has(character) || !LETTER_OR_DIGIT.test(character)) continue;
    return character.toLocaleUpperCase();
  }
  return null;
}

/** FNV-1a over the UTF-8 bytes, so the same id always lands on the same palette colour. */
export function avatarColorIndex(key: string): number {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(key)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % AVATAR_PALETTE.length;
}

/** The colour of a person: from their id, or from their name when no id is at hand. */
export function avatarColor(key: string | null | undefined, name: string): string {
  return AVATAR_PALETTE[avatarColorIndex(key || name)]!;
}

export type AvatarProps = { name: string; id?: string | null; image?: string | null; agent?: boolean; size?: "sm" | "md" };

const box = { sm: "size-5 text-10", md: "size-6 text-12" } as const;
const icon = { sm: 14, md: 16 } as const;

/** The Agent label next to a name: plain text, explained by a tooltip. */
export function AgentLabel() {
  return <span className="text-10 font-medium text-tertiary" title={translate("avatar.agentHint")}>{translate("comments.agent")}</span>;
}

export function Avatar({ name, id, image, agent, size = "sm" }: AvatarProps) {
  const [failed, setFailed] = React.useState(false);
  const letter = avatarLetter(name);
  if (agent) {
    return <span aria-hidden className={`grid ${box[size]} shrink-0 place-items-center rounded-md border border-subtle bg-surface-1 text-primary`}><Bot size={icon[size]} /></span>;
  }
  if (image && !failed) {
    return <img src={image} alt="" aria-hidden onError={() => setFailed(true)} className={`${box[size]} shrink-0 rounded-full object-cover`} />;
  }
  if (letter === null) {
    return <span aria-hidden className={`grid ${box[size]} shrink-0 place-items-center rounded-full bg-layer-3 text-secondary`}><User size={icon[size]} /></span>;
  }
  return <span aria-hidden className={`grid ${box[size]} shrink-0 place-items-center rounded-full font-semibold`} style={{ backgroundColor: avatarColor(id, name), color: "#fff" }}>{letter}</span>;
}

const botMark = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="8" width="16" height="12" rx="2"/><path d="M12 4v4M9 14h.01M15 14h.01"/></svg>';

/** The same Avatar for code that builds DOM by hand (the @mention list): one element with the same colour and letter rules. */
export function avatarElement(name: string, id: string | null | undefined, agent: boolean): HTMLSpanElement {
  const element = document.createElement("span");
  element.setAttribute("aria-hidden", "true");
  element.style.cssText = "display:inline-grid;place-items:center;width:20px;height:20px;flex-shrink:0;font-size:10px;font-weight:600;margin-right:6px;";
  if (agent) {
    element.style.cssText += "border-radius:6px;border:1px solid var(--border-subtle);background:var(--bg-surface-1);color:var(--txt-primary);";
    element.innerHTML = botMark;
    return element;
  }
  const letter = avatarLetter(name);
  element.style.cssText += letter === null ? "border-radius:50%;background:var(--bg-layer-3);color:var(--txt-secondary);" : `border-radius:50%;background:${avatarColor(id, name)};color:#fff;`;
  element.textContent = letter ?? "";
  return element;
}
