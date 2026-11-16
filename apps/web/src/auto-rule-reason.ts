import type { MessageKey } from "@weft/shared";

type Translate = (key: MessageKey) => string;

/**
 * The sentence for an automatic change. The server stores the reason as JSON (`{ autoRule: "idle_close", days, from, to }`) so it is written in
 * the reader's language here. A row written before that holds an English sentence: it is shown as stored.
 */
export function autoRuleReasonText(stored: string | null, translate: Translate): string | null {
  if (stored === null) return null;
  let data: unknown;
  try { data = JSON.parse(stored); } catch { return stored; }
  if (!data || typeof data !== "object") return stored;
  const reason = data as { autoRule?: unknown; days?: unknown; from?: unknown; to?: unknown };
  const days = typeof reason.days === "number" ? String(reason.days) : null;
  if (reason.autoRule === "idle_close" && days !== null) {
    return translate("autoRules.reason.idleClose").replace("{days}", days)
      .replace("{from}", typeof reason.from === "string" ? reason.from : translate("autoRules.reason.itsState"))
      .replace("{to}", typeof reason.to === "string" ? reason.to : translate("autoRules.reason.aClosedState"));
  }
  if (reason.autoRule === "done_archive" && days !== null) return translate("autoRules.reason.doneArchive").replace("{days}", days);
  return stored;
}

/**
 * The automatic changes the timeline may offer to undo: only the latest change to the same field (the server refuses anything else),
 * where an archive and a restore are one field. `chronological` lists the activities oldest first.
 */
export function undoableAutoRuleIds(chronological: Array<{ id: string; field: string; source: string }>): Set<string> {
  const family = (field: string) => field === "archived" || field === "restored" ? "archived" : field;
  const latest = new Map<string, { id: string; source: string }>();
  for (const row of chronological) latest.set(family(row.field), row);
  const ids = new Set<string>();
  for (const row of chronological) {
    if (row.source === "auto_rule" && (row.field === "state" || row.field === "archived") && latest.get(family(row.field))?.id === row.id) ids.add(row.id);
  }
  return ids;
}
