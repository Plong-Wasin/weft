/** The pending cards a group action applies to. With one card left there is nothing to tick, so it always counts, even if it was unticked while it had company. */
export function chosenCards<T extends { id: string }>(pending: T[], unselected: Record<string, true>): T[] {
  return pending.length > 1 ? pending.filter((card) => !unselected[card.id]) : pending;
}
