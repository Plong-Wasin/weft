const projectSidebarKey = (workspaceId: string, userId: string, projectId: string) =>
  `weft:project-sidebar:${workspaceId}:${userId}:${projectId}`;

export function readProjectSidebarOpen(workspaceId: string, userId: string, projectId: string, current: boolean) {
  if (current) return true;
  try {
    return window.localStorage.getItem(projectSidebarKey(workspaceId, userId, projectId)) === "true";
  } catch {
    return false;
  }
}

export function writeProjectSidebarOpen(workspaceId: string, userId: string, projectId: string, open: boolean) {
  try {
    window.localStorage.setItem(projectSidebarKey(workspaceId, userId, projectId), String(open));
  } catch {
    // The project menu remains usable when browser storage is unavailable.
  }
}
