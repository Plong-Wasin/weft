/** Extra action groups an Agent can be granted by a workspace Admin. */
export type AgentActionGrants = {
  allowProjectActions: boolean;
  allowMemberActions: boolean;
  allowFeatureActions: boolean;
  allowExportActions: boolean;
};

export type AgentActionGroup = "base" | "project" | "member" | "feature" | "export" | "denied";

const baseActions = new Set([
  "create_work_item", "update_work_item", "bulk_update_work_items", "move_work_item", "archive_work_item", "bulk_archive_work_items", "restore_work_item",
  "create_comment", "update_comment", "delete_comment", "create_work_item_relation", "remove_work_item_relation", "create_web_link", "update_web_link", "delete_web_link",
  "get_skill",
]);
const projectActions = new Set(["create_project", "update_project", "archive_project", "unarchive_project", "rename_project_key", "join_project"]);
const memberActions = new Set(["add_project_member", "remove_project_member"]);
const exportActions = new Set(["request_export"]);

export function agentActionGroup(action: string): AgentActionGroup {
  if (action.startsWith("delete_")) return "denied";
  if (baseActions.has(action) || action.includes("work_item") || action.includes("comment")) return "base";
  if (projectActions.has(action)) return "project";
  if (action.includes("project")) return "project";
  if (memberActions.has(action)) return "member";
  if (action.includes("member")) return "member";
  if (exportActions.has(action)) return "export";
  if (action.includes("export")) return "export";
  // Actions that alter workspace/project features (Cycles, Modules, Intake, Views,
  // states, labels, wiki pages, recurrences and feature switches) need an explicit grant.
  if (action.startsWith("create_") || action.startsWith("update_") || action.startsWith("archive_") || action.startsWith("unarchive_") || action.startsWith("move_") || action.startsWith("add_") || action.startsWith("remove_") || action.startsWith("transfer_") || action.startsWith("switch_") || action.startsWith("restore_") || action.startsWith("set_")) return "feature";
  return "feature";
}

export function agentMayUseAction(action: string, grants: AgentActionGrants): boolean {
  switch (agentActionGroup(action)) {
    case "base": return true;
    case "project": return grants.allowProjectActions;
    case "member": return grants.allowMemberActions;
    case "feature": return grants.allowFeatureActions;
    case "export": return grants.allowExportActions;
    case "denied": return false;
  }
}

export function agentActionRefusal(action: string): string {
  return agentActionGroup(action) === "denied" && action.startsWith("delete_")
    ? "Agents cannot delete anything"
    : "This action is not enabled for this Agent";
}
