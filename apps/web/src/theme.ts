import React from 'react';

export type ThemeChoice = 'system' | 'light' | 'dark';
const KEY = 'weft-theme';
const listeners = new Set<() => void>();

function read(): ThemeChoice {
  try { const saved = localStorage.getItem(KEY); if (saved === 'light' || saved === 'dark') return saved; } catch { /* blocked storage: follow the system */ }
  return 'system';
}

let current = read();
function apply() {
  if (current === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', current);
}
apply();

export function setTheme(next: ThemeChoice) {
  current = next;
  try { if (next === 'system') localStorage.removeItem(KEY); else localStorage.setItem(KEY, next); } catch { /* the choice still applies this session */ }
  apply();
  listeners.forEach((listener) => listener());
}

export function useTheme(): ThemeChoice {
  return React.useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => current, () => current);
}
