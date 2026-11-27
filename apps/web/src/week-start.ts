import React from "react";

export const weekStarts = ["sunday", "monday"] as const;
export type WeekStart = (typeof weekStarts)[number];
const STORAGE_KEY = "weft.weekStart";

/** The first day of a week in calendar displays. It is kept per browser, like the theme. */
export function readWeekStart(): WeekStart {
  try { if (localStorage.getItem(STORAGE_KEY) === "monday") return "monday"; } catch { /* storage unavailable: use the default */ }
  return "sunday";
}

export function storeWeekStart(weekStart: WeekStart) {
  try { if (weekStart === "sunday") localStorage.removeItem(STORAGE_KEY); else localStorage.setItem(STORAGE_KEY, weekStart); } catch { /* the choice still applies until reload */ }
}

export function useWeekStart(): [WeekStart, (weekStart: WeekStart) => void] {
  const [weekStart, setWeekStart] = React.useState<WeekStart>(readWeekStart);
  return [weekStart, (next) => { setWeekStart(next); storeWeekStart(next); }];
}
