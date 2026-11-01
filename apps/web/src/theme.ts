import React from "react";

export const themes = ["system", "light", "dark"] as const;
export type Theme = (typeof themes)[number];
const STORAGE_KEY = "weft.theme";

export function readTheme(): Theme {
  try { const stored = localStorage.getItem(STORAGE_KEY); if (stored === "light" || stored === "dark") return stored; } catch { /* storage unavailable: follow the system */ }
  return "system";
}

/** The tokens in tokens.css switch on `data-theme` of <html>; "system" resolves to the OS preference. */
export function applyTheme(theme: Theme, root: { setAttribute(name: string, value: string): void } = document.documentElement, prefersDark: boolean = window.matchMedia("(prefers-color-scheme: dark)").matches) {
  root.setAttribute("data-theme", theme === "system" ? (prefersDark ? "dark" : "light") : theme);
}

export function initTheme() {
  applyTheme(readTheme());
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { if (readTheme() === "system") applyTheme("system"); });
}

export function useTheme(): [Theme, (theme: Theme) => void] {
  const [theme, setTheme] = React.useState<Theme>(readTheme);
  return [theme, (next) => {
    setTheme(next);
    try { if (next === "system") localStorage.removeItem(STORAGE_KEY); else localStorage.setItem(STORAGE_KEY, next); } catch { /* the choice still applies until reload */ }
    applyTheme(next);
  }];
}
