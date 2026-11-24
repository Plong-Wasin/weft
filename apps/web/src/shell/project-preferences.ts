import React from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { action } from "../api";
import type { Project } from "../types";

/** One person's sidebar state for one project, as the server stores it. */
export type ProjectPreference = { projectId: string; starred: boolean; position: number | null; expanded: boolean };

export const projectPreferencesKey = (workspaceId: string) => ["project-preferences", workspaceId] as const;

type PreferenceWriteQueue = { tail: Promise<void>; revision: number; needsReload: boolean };
const preferenceWriteQueues = new WeakMap<QueryClient, Map<string, PreferenceWriteQueue>>();

/** All preference writers for one workspace and QueryClient share order and revision state across hook instances. */
function preferenceWriteQueue(client: QueryClient, workspaceId: string): PreferenceWriteQueue {
  let workspaces = preferenceWriteQueues.get(client);
  if (!workspaces) { workspaces = new Map(); preferenceWriteQueues.set(client, workspaces); }
  let queue = workspaces.get(workspaceId);
  if (!queue) { queue = { tail: Promise.resolve(), revision: 0, needsReload: false }; workspaces.set(workspaceId, queue); }
  return queue;
}

function enqueuePreferenceWrite<T>(queue: PreferenceWriteQueue, write: () => Promise<T>): Promise<T> {
  const result = queue.tail.then(write);
  queue.tail = result.then(() => undefined, () => undefined);
  return result;
}

async function restorePreferenceCache(client: QueryClient, key: ReturnType<typeof projectPreferencesKey>, workspaceId: string, queue: PreferenceWriteQueue, revision: number) {
  const restored = await action<ProjectPreference[]>("list_project_preferences", { workspaceId });
  if (restored === null || revision !== queue.revision) return false;
  client.setQueryData<ProjectPreference[]>(key, restored);
  queue.needsReload = false;
  return true;
}

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

export function matchesProjectSearch(project: Project, query: string): boolean {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const matches = (project: Project) => {
    const text = `${project.name} ${project.key}`.toLocaleLowerCase();
    return words.every((word) => text.includes(word));
  };
  return matches(project);
}

/** Filters each existing navigation group without changing its saved order or starred status. */
export function filterProjectGroups(projects: Project[], prefs: ProjectPreference[], query: string) {
  const groups = sortProjects(projects, prefs);
  const matches = (project: Project) => matchesProjectSearch(project, query);
  return { starred: groups.starred.filter(matches), others: groups.others.filter(matches) };
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
 * The person's sidebar state for a workspace. Writes update the cache immediately and serialize per workspace; only current
 * responses update it again, while failures reload the saved state.
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
  const current = React.useCallback(() => client.getQueryData<ProjectPreference[]>(key) ?? [], [client, key]);
  const writeQueue = preferenceWriteQueue(client, workspaceId);

  const setPreference = React.useCallback(async (projectId: string, patch: { starred?: boolean; expanded?: boolean }) => {
    const revision = ++writeQueue.revision;
    const before = current();
    const existing = preferenceOf(before, projectId) ?? { projectId, starred: false, position: null, expanded: false };
    client.setQueryData<ProjectPreference[]>(key, [...before.filter((pref) => pref.projectId !== projectId), { ...existing, ...patch }]);
    return enqueuePreferenceWrite(writeQueue, async () => {
      const saved = await action<ProjectPreference>("set_project_preference", { projectId, ...patch });
      if (saved) {
        if (revision === writeQueue.revision) {
          if (writeQueue.needsReload) await restorePreferenceCache(client, key, workspaceId, writeQueue, revision);
          else client.setQueryData<ProjectPreference[]>(key, [...current().filter((pref) => pref.projectId !== projectId), saved]);
        }
      } else {
        writeQueue.needsReload = true;
        if (revision === writeQueue.revision) await restorePreferenceCache(client, key, workspaceId, writeQueue, revision);
      }
    });
  }, [client, key, current, workspaceId, writeQueue]);

  const setOrder = React.useCallback(async (order: string[]) => {
    const revision = ++writeQueue.revision;
    client.setQueryData<ProjectPreference[]>(key, orderAsPreferences(current(), order));
    return enqueuePreferenceWrite(writeQueue, async () => {
      const saved = await action<ProjectPreference[]>("set_project_order", { workspaceId, projectIds: order });
      if (saved) {
        if (revision === writeQueue.revision) {
          client.setQueryData<ProjectPreference[]>(key, saved);
          writeQueue.needsReload = false;
        }
        return { saved: true, restored: false, current: revision === writeQueue.revision };
      }
      writeQueue.needsReload = true;
      if (revision !== writeQueue.revision) return { saved: false, restored: false, current: false };
      const restored = await restorePreferenceCache(client, key, workspaceId, writeQueue, revision);
      return { saved: false, restored, current: revision === writeQueue.revision };
    });
  }, [client, key, current, workspaceId, writeQueue]);

  const resetOrder = React.useCallback(async () => {
    const revision = ++writeQueue.revision;
    client.setQueryData<ProjectPreference[]>(key, current().map((pref) => ({ ...pref, position: null })));
    return enqueuePreferenceWrite(writeQueue, async () => {
      const saved = await action<ProjectPreference[]>("reset_project_order", { workspaceId });
      if (saved) {
        if (revision === writeQueue.revision) {
          client.setQueryData<ProjectPreference[]>(key, saved);
          writeQueue.needsReload = false;
        }
      } else {
        writeQueue.needsReload = true;
        if (revision === writeQueue.revision) await restorePreferenceCache(client, key, workspaceId, writeQueue, revision);
      }
    });
  }, [client, key, current, workspaceId, writeQueue]);

  return { prefs, loaded: query.data !== undefined, setPreference, setOrder, resetOrder };
}
