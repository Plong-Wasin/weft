type Role = "Admin" | "Member" | "Guest" | null;

/** Mirrors requireProjectAccess for project write and admin controls. */
export function projectFeaturePermissions(workspaceRole: Role, projectRole: Role, archived = false): { canWrite: boolean; canAdmin: boolean } {
  if (archived) return { canWrite: false, canAdmin: false };
  const isWorkspaceAdmin = workspaceRole === "Admin";
  return {
    canWrite: isWorkspaceAdmin || (workspaceRole !== null && workspaceRole !== "Guest" && (projectRole === "Admin" || projectRole === "Member")),
    canAdmin: isWorkspaceAdmin || (workspaceRole !== null && workspaceRole !== "Guest" && projectRole === "Admin"),
  };
}
