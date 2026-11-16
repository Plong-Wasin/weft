/** Extra action groups an Agent can be granted by its owner (a workspace Admin for a server Agent, the Runtime owner for a Code-capable Agent). */
export type AgentActionGrants = {
  allowProjectActions: boolean;
  allowMemberActions: boolean;
  allowFeatureActions: boolean;
  allowExportActions: boolean;
};

export type AgentActionGroup = "base" | "project" | "member" | "feature" | "export" | "denied";

/** The only Actions open to an Agent with no grants. An exact list on purpose: a new Action is refused until someone adds it here. */
// Documented read-only exception: list_work_item_pull_requests only reads pull request links already shown on a work item.
// the Agent can see, and it is hidden together with the other integration actions while the integrations switch is off.
const baseActions = new Set([
  "archive_work_item", "bulk_archive_work_items", "bulk_update_work_items", "create_comment", "create_web_link", "create_wiki_page_comment",
  "create_work_item", "create_work_item_relation", "get_asset_download_url", "get_project", "get_skill", "get_work_item", "link_work_item_page",
  "list_assets", "list_comment_versions", "list_comments", "list_labels", "list_members", "list_mentionable_members", "list_project_members",
  "list_projects", "list_states", "list_sub_work_items", "list_timeline", "list_web_links", "list_wiki_page_comments", "list_wiki_page_work_items",
  "list_work_item_activities", "list_work_item_description_versions", "list_work_item_pages", "list_work_item_pull_requests", "list_work_item_relations", "list_work_items",
  "list_workspace_work_items", "move_work_item", "remove_work_item_relation", "reply_wiki_page_comment", "resolve_wiki_page_comment",
  "restore_work_item", "restore_work_item_description_version", "search_work_items", "unlink_work_item_page", "update_comment", "update_web_link",
  "update_wiki_page_comment", "update_work_item",
]);
const projectActions = new Set(["create_project", "update_project", "archive_project", "unarchive_project", "rename_project_key", "join_project"]);
const memberActions = new Set(["add_project_member", "remove_project_member", "change_project_member_role", "change_member_role", "remove_member"]);
const exportActions = new Set(["request_export"]);
const destructivePattern = /(^|_)(delete|purge|destroy|wipe|truncate|erase|drop|obliterate)(_|$)/;
/**
 * Account, security and self-modifying surfaces: credentials, sessions, passwords, invitations, mail preferences, repository
 * integrations (webhook secrets), OAuth grants, and everything that configures Agents, Skills, Triggers, Runtimes, Daemons,
 * Autopilot, Runs, recurrences, sharing and publishing. Only people use these, never an Agent, whatever its grants.
 */
const peopleOnlyPattern = /api_token|security_notice|session|password|invite|sign_out|suspend|email_preference|integration|secret|credential|authorized_app|publish|share|visibility|access|revoke_|reactivate_|audit_log|member_accounts|merged_pr|auto_rule|usage|model_price|project_preference|project_order|(^|_)(agent|agents|skill|skills|trigger|triggers|runtime|runtimes|daemon|autopilot|recurrence|recurrences|run|runs|run_limits)(_|$)/;
const featureVerbs = ["create_", "update_", "archive_", "unarchive_", "move_", "add_", "remove_", "transfer_", "switch_", "restore_", "set_", "reorder_", "lock_", "unlock_", "favorite_", "accept_", "reject_", "snooze_", "submit_", "duplicate_", "mark_", "complete_", "request_", "rename_", "pause_", "resume_"];

/** The group of an action, or undefined when no rule names it. An undefined action is refused (fail closed); a test over the whole Action list keeps this empty. */
export function classifyAgentAction(action: string): AgentActionGroup | undefined {
  // Destructive verbs anywhere in the name are refused, not only a delete_ prefix ("purge_work_item", "bulk_delete_work_items").
  if (destructivePattern.test(action)) return "denied";
  if (baseActions.has(action)) return "base";
  if (peopleOnlyPattern.test(action)) return "denied";
  // Membership is checked before the project group: "add_project_member" contains "project" but is a member action.
  if (memberActions.has(action) || action.includes("member")) return "member";
  if (projectActions.has(action) || action.includes("project")) return "project";
  if (exportActions.has(action) || action.includes("export")) return "export";
  // Actions that alter workspace/project features (Cycles, Modules, Intake, Views, states, labels, wiki pages, estimates
  // and notifications) and the read actions on them need an explicit grant.
  if (featureVerbs.some((verb) => action.startsWith(verb)) || /^(list|get|search|check)_/.test(action)) return "feature";
  return undefined;
}

export function agentActionGroup(action: string): AgentActionGroup {
  return classifyAgentAction(action) ?? "denied";
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
