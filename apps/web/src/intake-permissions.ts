type Role = "Admin" | "Member" | "Guest" | null;

/** Mirrors requireProjectAccess(..., "write") for Intake decision controls. */
export function canDecideIntake(workspaceRole: Role, projectRole: Role): boolean {
  return workspaceRole === "Admin" || (workspaceRole === "Member" && (projectRole === "Admin" || projectRole === "Member"));
}
