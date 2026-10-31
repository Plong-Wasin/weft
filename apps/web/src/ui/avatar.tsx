import type { Assignee } from '../types';

const HUES = [235, 155, 75, 300, 20, 195];

export function displayName(name: string) { return name.split('@')[0]; }

export function initials(name: string): string {
  const parts = displayName(name).split(/[\s._-]+/).filter(Boolean);
  const letters = parts.length > 1 ? parts[0][0] + parts[1][0] : (parts[0] ?? '?').slice(0, 2);
  return letters.toUpperCase();
}

function hueOf(seed: string) {
  let hash = 0;
  for (const ch of seed) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return HUES[hash % HUES.length];
}

/** A round initials badge; a Team gets a rounded square so the two kinds never look alike. */
export function Avatar({ name, id, team, size = 22 }: { name: string; id: string; team?: boolean; size?: number }) {
  const hue = hueOf(id);
  return <span className={`avatar ${team ? 'avatar-team' : ''}`} aria-hidden="true" style={{ width: size, height: size, fontSize: Math.round(size * 0.42), background: `oklch(92% 0.05 ${hue})`, color: `oklch(32% 0.09 ${hue})` }}>{team ? <svg viewBox="0 0 24 24" width={size * 0.6} height={size * 0.6}><path d="M9 11.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 19.5a6.5 6.5 0 0 1 13 0M16 4.8a3.5 3.5 0 0 1 0 6.4M18 14a6.5 6.5 0 0 1 3.5 5.5" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" /></svg> : initials(name)}</span>;
}

export function AvatarStack({ assignees, max = 3 }: { assignees: Assignee[]; max?: number }) {
  const shown = assignees.slice(0, max);
  return <span className="avatar-stack">{shown.map((item) => <Avatar key={`${item.type}:${item.id}`} name={item.name} id={item.id} team={item.type === 'team'} />)}{assignees.length > max && <span className="avatar avatar-more" aria-hidden="true">+{assignees.length - max}</span>}</span>;
}
