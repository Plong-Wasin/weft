import React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { action } from "../api";
import type { Project } from "../types";

/** One person's sidebar state for one project, as the server stores it. */
export type ProjectPreference = { projectId: string; starred: boolean; position: number | null; expanded: boolean };

export const projectPreferencesKey = (workspaceId: string) => ["project-preferences", workspaceId] as const;

export function preferenceOf(prefs: ProjectPreference[], projectId: string): ProjectPreference | undefined {
  return prefs.find((pref) => pref.projectId === projectId);
}

/** The Starred group, then everything else. Inside each group: ordered projects by position, then never-ordered projects by name. */
export function sortProjects(projects: Project[], prefs: ProjectPreference[]) {
  const rank = (project: Project) => preferenceOf(prefs, project.id)?.position ?? Number.POSITIVE_INFINITY;
  const sorted = [...projects].sort((a, b) => {
    const difference = rank(a) - rank(b);
    if (difference !== 0 && !Number.isNaN(difference)) return difference;
    return a.name.localeCompare(b.name) || a.key.localeCompare(b.key);
  });
  const starred = sorted.filter((project) => preferenceOf(prefs, project.id)?.starred);
  const others = sorted.filter((project) => !preferenceOf(prefs, project.id)?.starred);
  return { starred, others };
}

/** The whole order as project ids, Starred first, as the server stores it. */
export function fullOrder(starred: Project[], others: Project[]) {
  return [...starred, ...others].map((project) => project.id);
}

/**
 * The order after moving one project one place up or down inside its own group. Returns null when the move would leave the group
 * (the first item moved up, the last moved down) or the project is not listed.
 */
export function moveWithinGroup(projects: Project[], prefs: ProjectPreference[], projectId: string, delta: -1 | 1): string[] | null {
  const groups = sortProjects(projects, prefs);
  for (const [starred, group] of [[true, groups.starred], [false, groups.others]] as const) {
    const index = group.findIndex((project) => project.id === projectId);
    if (index === -1) continue;
    const target = index + delta;
    if (target < 0 || target >= group.length) return null;
    const next = [...group];
    [next[index], next[target]] = [next[target]!, next[index]!];
    return starred ? fullOrder(next, groups.others) : fullOrder(groups.starred, next);
  }
  return null;
}

/** The order after dropping one project onto another in the same group: the dragged project takes the target's place. Null across groups. */
export function dropWithinGroup(projects: Project[], prefs: ProjectPreference[], fromId: string, toId: string): string[] | null {
  if (fromId === toId) return null;
  const groups = sortProjects(projects, prefs);
  for (const [starred, group] of [[true, groups.starred], [false, groups.others]] as const) {
    const from = group.findIndex((project) => project.id === fromId);
    const to = group.findIndex((project) => project.id === toId);
    if (from === -1 || to === -1) continue;
    const next = [...group];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved!);
    return starred ? fullOrder(next, groups.others) : fullOrder(groups.starred, next);
  }
  return null;
}

/** Positions for a full order: the listed projects take their index, so the order is exactly what the person saw. */
export function orderAsPreferences(prefs: ProjectPreference[], order: string[]): ProjectPreference[] {
  const positions = new Map(order.map((id, index) => [id, index]));
  const ids = new Set([...prefs.map((pref) => pref.projectId), ...order]);
  return [...ids].map((projectId) => ({
    ...(preferenceOf(prefs, projectId) ?? { projectId, starred: false, expanded: false }),
    projectId,
    position: positions.get(projectId) ?? null,
  }));
}

/**
 * The person's sidebar state for a workspace, and the writes that change it. Each write updates the cache first so the sidebar
 * moves at once, then the server's answer replaces it; a failed write reloads the saved state.
 */
export function useProjectPreferences(workspaceId: string, enabled = true) {
  const client = useQueryClient();
  const key = projectPreferencesKey(workspaceId);
  const query = useQuery({
    queryKey: key,
    queryFn: async () => await action<ProjectPreference[]>("list_project_preferences", { workspaceId }) ?? [],
    enabled: enabled && workspaceId !== "",
  });
  const prefs = query.data ?? [];
  const reload = React.useCallback(async () => { await client.invalidateQueries({ queryKey: key }); }, [client, key]);
  const current = React.useCallback(() => client.getQueryData<ProjectPreference[]>(key) ?? [], [client, key]);

  const setPreference = React.useCallback(async (projectId: string, patch: { starred?: boolean; expanded?: boolean }) => {
    const before = current();
    const existing = preferenceOf(before, projectId) ?? { projectId, starred: false, position: null, expanded: false };
    client.setQueryData<ProjectPreference[]>(key, [...before.filter((pref) => pref.projectId !== projectId), { ...existing, ...patch }]);
    const saved = await action<ProjectPreference>("set_project_preference", { projectId, ...patch });
    if (!saved) await reload();
  }, [client, key, current, reload]);

  const setOrder = React.useCallback(async (order: string[]) => {
    client.setQueryData<ProjectPreference[]>(key, orderAsPreferences(current(), order));
    const saved = await action<ProjectPreference[]>("set_project_order", { workspaceId, projectIds: order });
    if (saved) client.setQueryData<ProjectPreference[]>(key, saved);
    else await reload();
  }, [client, key, current, reload, workspaceId]);

  const resetOrder = React.useCallback(async () => {
    client.setQueryData<ProjectPreference[]>(key, current().map((pref) => ({ ...pref, position: null })));
    const saved = await action<ProjectPreference[]>("reset_project_order", { workspaceId });
    if (saved) client.setQueryData<ProjectPreference[]>(key, saved);
    else await reload();
  }, [client, key, current, reload, workspaceId]);

  return { prefs, loaded: query.data !== undefined, setPreference, setOrder, resetOrder };
}
