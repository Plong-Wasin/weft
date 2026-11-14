import { expect, test } from "bun:test";
import { createActionList } from "../src";
import { agentActionGroup, agentMayUseAction, classifyAgentAction } from "../src/agent-action-policy";

const allGrants = { allowProjectActions: true, allowMemberActions: true, allowFeatureActions: true, allowExportActions: true };
const noGrants = { allowProjectActions: false, allowMemberActions: false, allowFeatureActions: false, allowExportActions: false };
const noMemberGrant = { ...allGrants, allowMemberActions: false };
// Built with both feature flags on, so the integration and webhook Actions are in the registry-wide classification check.
const actions = (createActionList as (db: never, options: { integrations: boolean; outboundWebhooks: boolean }) => Array<{ name: string; kind: string }>)({} as never, { integrations: true, outboundWebhooks: true });

test("the registry with feature flags on classifies every Action and denies every type/property write even with all grants", () => {
  const settingsWrites = actions.filter((action) => /(work_item_type|custom_property)/.test(action.name) && !/^(list|get|search)_/.test(action.name));
  expect(settingsWrites.map((action) => action.name).filter((name) => agentMayUseAction(name, allGrants))).toEqual([]);
  expect(settingsWrites.every((action) => agentActionGroup(action.name) === "denied")).toBe(true);
  const unclassified = actions.filter((action) => classifyAgentAction(action.name) === undefined).map((action) => action.name);
  expect(unclassified).toEqual([]);
});

test("the registry built with the flags on contains the integration and webhook Actions", () => {
  const names = actions.map((action) => action.name);
  expect(names).toContain("create_work_item_integration");
  expect(names).toContain("create_outbound_webhook");
  for (const name of ["create_work_item_type", "update_work_item_type", "delete_work_item_type", "create_custom_property", "update_custom_property", "delete_custom_property"]) {
    const action = actions.find((entry) => entry.name === name);
    expect(action, `expected ${name} to exist in the Action registry`).toBeDefined();
    expect(agentActionGroup(name)).toBe("denied");
    expect(agentMayUseAction(name, allGrants)).toBe(false);
  }
  for (const futureName of ["reorder_work_item_types", "reorder_custom_properties"]) {
    expect(agentActionGroup(futureName)).toBe("denied");
    expect(agentMayUseAction(futureName, allGrants)).toBe(false);
  }
});

test("an Action name no rule knows is refused whatever the grants", () => {
  expect(agentActionGroup("frobnicate_thing")).toBe("denied");
  expect(agentMayUseAction("frobnicate_thing", allGrants)).toBe(false);
});

test("membership actions follow the member grant, not the project grant", () => {
  for (const action of ["add_project_member", "remove_project_member", "change_project_member_role", "change_member_role", "remove_member"]) {
    expect(agentActionGroup(action)).toBe("member");
    expect(agentMayUseAction(action, noMemberGrant)).toBe(false);
    expect(agentMayUseAction(action, allGrants)).toBe(true);
  }
});

test("account, security and Agent-configuring actions are never available to an Agent, whatever the grants", () => {
  for (const action of [
    "create_api_token", "revoke_api_token", "list_api_tokens", "list_member_api_tokens", "revoke_member_api_token",
    "force_password_reset", "sign_out_everywhere", "sign_out_member", "suspend_member", "revoke_my_session", "list_my_sessions",
    "create_invite", "accept_invite", "revoke_invite", "set_my_email_preferences", "create_work_item_integration", "rotate_work_item_integration_secret",
    "list_authorized_apps", "revoke_authorized_app", "register_daemon", "create_agent", "update_agent", "enable_agent", "disable_agent", "set_agent_access",
    "set_agent_skills", "create_skill", "update_skill", "create_trigger", "update_trigger", "create_recurrence", "run_recurrence_now", "share_runtime",
    "unshare_runtime", "set_autopilot_setting", "set_runtime_run_limits", "publish_wiki_page", "share_wiki_page",
    "rerun_run", "cancel_run", "reactivate_member", "list_audit_log", "export_audit_log", "list_member_accounts", "cancel_forced_password_reset",
    "get_project_merged_pr_setting", "set_project_merged_pr_setting",
    "get_usage_summary", "list_model_prices", "set_model_price", "delete_model_price",
    "list_project_preferences", "list_project_preference", "set_project_preference", "set_project_order", "reset_project_order",
  ]) {
    expect(agentActionGroup(action)).toBe("denied");
    expect(agentMayUseAction(action, allGrants)).toBe(false);
  }
});

test("the lookups an Agent needs to work with work items and comments stay open with no grants", () => {
  for (const action of ["list_states", "list_labels", "list_projects", "get_project", "list_members", "list_mentionable_members", "list_timeline", "get_skill"]) {
    expect(agentMayUseAction(action, noGrants)).toBe(true);
  }
});

test("work item and comment actions stay open and delete stays refused", () => {
  expect(agentMayUseAction("create_work_item", noGrants)).toBe(true);
  expect(agentMayUseAction("update_comment", noGrants)).toBe(true);
  expect(agentMayUseAction("delete_work_item", allGrants)).toBe(false);
});

test("every work item and comment Action in the registry is open to an Agent with no grants, unless it is a people-only surface", () => {
  // Work item types and custom properties are project settings (like states), so they are feature Actions, not work item Actions.
  const closed = actions.filter((action) => /work_item|comment/.test(action.name) && !/work_item_type|integration/.test(action.name) && !action.name.startsWith("delete_") && !agentMayUseAction(action.name, noGrants)).map((action) => action.name);
  expect(closed).toEqual([]);
});

test("a destructive verb anywhere in an Action name is refused, not only a delete_ prefix", () => {
  for (const action of ["purge_work_item", "bulk_delete_work_items", "purge_comments", "truncate_work_item_comments", "wipe_project", "destroy_view", "erase_work_item_history"]) {
    expect(agentActionGroup(action)).toBe("denied");
    expect(agentMayUseAction(action, allGrants)).toBe(false);
  }
  const destructive = actions.filter((action) => /(^|_)(delete|purge|destroy|wipe|truncate|erase|drop)(_|$)/.test(action.name));
  expect(destructive.length).toBeGreaterThan(0);
  expect(destructive.filter((action) => agentMayUseAction(action.name, allGrants))).toEqual([]);
});

test("a work item or comment Action that is not on the allowlist is not open without grants", () => {
  for (const action of ["import_work_items", "transfer_work_item_ownership", "export_work_items", "clone_comment_thread"]) {
    expect(agentMayUseAction(action, noGrants)).toBe(false);
  }
});
