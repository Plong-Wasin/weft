import { expect, test } from "bun:test";
import { projectFeaturePermissions } from "../src/project-feature-permissions";

test("project feature controls match project write and admin permissions", () => {
  expect(projectFeaturePermissions("Member", null)).toEqual({ canWrite: false, canAdmin: false });
  expect(projectFeaturePermissions("Guest", null)).toEqual({ canWrite: false, canAdmin: false });
  expect(projectFeaturePermissions("Member", "Member")).toEqual({ canWrite: true, canAdmin: false });
  expect(projectFeaturePermissions("Member", "Admin")).toEqual({ canWrite: true, canAdmin: true });
  expect(projectFeaturePermissions("Admin", null)).toEqual({ canWrite: true, canAdmin: true });
  expect(projectFeaturePermissions("Member", "Guest")).toEqual({ canWrite: false, canAdmin: false });
});

test("archived Projects have no write or admin controls for any role combination", () => {
  const roles = ["Admin", "Member", "Guest", null] as const;
  for (const workspaceRole of roles) {
    for (const projectRole of roles) {
      expect(projectFeaturePermissions(workspaceRole, projectRole, true)).toEqual({ canWrite: false, canAdmin: false });
    }
  }
});
