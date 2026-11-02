import type { ProjectFeatures } from "./project-nav";

export type Workspace = { id: string; name: string; slug: string };
export type Role = "Admin" | "Member" | "Guest";
export type Member = { userId: string; name: string; email: string; role: Role; isAgent?: boolean };
export type Project = { id: string; key: string; name: string; visibility: "public" | "private"; archived: boolean; role: Role | null; features: ProjectFeatures };
export type Current = { user: { id: string; name: string; email: string; locale: string }; workspaces: Workspace[]; canCreateWorkspace: boolean };
export const roles = ["Admin", "Member", "Guest"] as const;
export const priorities = ["urgent", "high", "medium", "low", "none"] as const;
export type StateGroup = "backlog" | "unstarted" | "started" | "completed" | "cancelled";
export const stateGroups: StateGroup[] = ["backlog", "unstarted", "started", "completed", "cancelled"];
export type WorkState = { id: string; name: string; group: StateGroup };
export type WorkItem = { id: string; projectId: string; createdBy: string; displayId: string; title: string; description: unknown; descriptionText: string; stateId: string; priority: (typeof priorities)[number]; estimatePointId: string | null; assigneeIds: string[]; labelIds: string[]; parentId: string | null; startDate: string | null; dueDate: string | null; archivedAt?: string | null };
export type Label = { id: string; projectId: string; name: string; color: string };

export type EstimatePoint = { id: string; position: number; value: string };
export type Estimate = { id: string; projectId: string; name: string; type: "points" | "categories"; enabled: boolean; points: EstimatePoint[] };
