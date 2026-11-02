import { pqlSyntaxHelp } from "./pql";

/**
 * One-line usage notes appended to an Action's description on every model-facing surface (AI tools, MCP tools,
 * CLI help). They say how to pick between look-alike Actions; the field descriptions carry the syntax itself.
 */
export const actionNotes: Record<string, string> = {
  list_work_items: `Lists one project's work items. Filter them with the \`query\` field, which is a PQL query (not free text). ${pqlSyntaxHelp}`,
  search_work_items: `Searches a workspace. \`query\` is free text matched against titles, ids and descriptions. \`pql\` is a PQL query and needs \`projectId\`; give \`pql\` to filter by fields such as priority, cycle or module, and \`query\` to look for words. Use list_work_items when you only need to filter one project. PQL reference: ${pqlSyntaxHelp}`,
  list_cycles: "Lists a project's Cycles with computed status (upcoming, active, completed) and progress. Use it to find a cycleId.",
  get_cycle: "Reads one Cycle and the ids of its work items.",
  get_cycle_burndown: "Read-only: work items still open each day of a Cycle against a straight ideal line to zero. Days after today are null. Archived and Triage items are not counted.",
  check_cycle_dates: "Read-only: returns Cycles whose dates overlap the given dates. Overlap is a warning, not an error.",
  add_cycle_items: "A work item belongs to at most one Cycle: items already in another Cycle are skipped and reported. Adding to a Cycle that has ended is refused.",
  transfer_cycle_items: "Moves the unfinished work items of a finished Cycle into another Cycle of the same project.",
  get_estimate: "Reads a project's Estimate: its type (points or categories) and its 2 to 6 ordered points, or null when the project has none.",
  get_estimate_usage: "Counts the work items that hold an Estimate point (project Admin only). Read it before proposing switch_estimate_type or delete_estimate and tell the user the number.",
  switch_estimate_type: "Switches the Estimate to the other system (points or categories) with a new list of 2 to 6 values and CLEARS the Estimate point of every work item in the project. Always state the affected count first (get_estimate_usage).",
  delete_estimate: "Deletes the project's Estimate and CLEARS the Estimate point of every work item in the project. Always state the affected count first (get_estimate_usage).",
  update_estimate: "Renames, turns on or off, or edits the points of the Estimate (project Admin only). `points` is the full ordered list: keep a point by its id, add one without id, leave one out to delete it.",
  get_analytics_summary: "Counts work items of the projects the caller can read: total, open (not completed or cancelled), completed and overdue (open with a past due date). Archived and Triage work items are never counted. Workspace Admin or Member only.",
  get_analytics_overview: "Summary counts plus one row per project the caller can read with its total, open and completed work items. Archived and Triage work items are never counted. Workspace Admin or Member only.",
  get_created_vs_resolved: "Work items created and resolved per calendar month (UTC, YYYY-MM), gaps filled with zeros. Created counts by creation month; resolved counts items that are completed now, by the month they were completed (a reopened item is not resolved). `projectIds` narrows the projects. Archived and Triage work items are never counted. Workspace Admin or Member only.",
  get_analytics_insights: "Counts work items by an X axis (state, stateGroup, priority, label, assignee, cycle, module, or createdDate, dueDate, startDate, completedDate by month) with an optional groupBy that must differ from x. An item with several labels, assignees or modules counts under each, and under a null key (none) when it has none. `projectIds` narrows the projects. Workspace Admin or Member only.",
  list_modules: "Lists a project's Modules (status, lead, progress). Use it to find a moduleId.",
  get_module: "Reads one Module and the ids of its work items.",
  list_views: "Lists a project's saved Views (a PQL filter, layout, group by, order by and visible properties). Private Views of other people are not listed.",
  get_view: "Reads one saved View. A private View of someone else is not found.",
  list_workspace_views: "Lists the four built-in workspace views (all, assigned, created, subscribed; they cannot be changed or deleted) and the workspace Views the caller may see.",
  create_workspace_view: "Saves a workspace View that spans every project the viewer can access. Same fields as create_view.",
  list_workspace_work_items: "Lists work items across every project the caller can access in the workspace. `builtin` picks all, assigned (to me), created (by me) or subscribed (created, assigned or commented by me).",
  create_view: "Saves a View: `query` is a PQL query; layout is list, board or spreadsheet; `subGroupBy` optionally adds board swimlanes or nested list sections and must differ from `groupBy`. A View never stores work items.",
  update_view: "Changes a View. Only its owner or a project Admin may.",
  delete_view: "Deletes a View, not its work items. Only its owner or a project Admin may.",
  list_intake_items: "Lists a project's Intake: work items submitted for a decision. Pending items are the default. Intake work items never appear in list_work_items or search_work_items until accepted.",
  submit_intake_item: "Submits a new work item to a project's Intake for the team to decide on. It is not a normal work item until accepted: use create_work_item to create work directly.",
  update_intake_item: "Edits an Intake item's title, description, or priority before it is decided.",
  accept_intake_item: "Decision: accept an Intake item. It becomes a normal backlog work item.",
  reject_intake_item: "Decision: reject an Intake item. It stays out of normal lists.",
  snooze_intake_item: "Decision: hide an Intake item from the pending list until a date.",
  duplicate_intake_item: "Decision: mark an Intake item as a duplicate of an existing work item.",
  list_work_item_relations: "Lists a work item's Relations (blocks, blocked_by, duplicate, relates_to).",
  create_work_item_relation: "Links two work items of the same project. `blocks` and `blocked_by` are two views of one link; `duplicate` and `relates_to` are symmetric.",
  list_web_links: "Lists the Web Links attached to one work item.",
  create_web_link: "Adds an http(s) Web Link to a work item. A title is optional.",
  update_web_link: "Changes the URL or optional title of an existing Web Link.",
  delete_web_link: "Removes an existing Web Link from a work item.",
  list_work_item_description_versions: "Lists the saved earlier descriptions of one work item, newest first.",
  restore_work_item_description_version: "Replaces a work item's description with an earlier saved version. The current description is saved first, so the restore can be undone.",
  create_comment: "Adds a comment to a work item. Give `parentId` (a top-level comment) to reply; a reply to a reply is refused.",
  list_comments: "Lists a work item's comments, replies nested under their parent.",
  list_timeline: "One feed of a work item's comments and Activity; filter All, Comments, or Updates.",
  set_project_features: "Turns Cycles, Modules, or Intake on or off for a project (project Admin only). Data is kept when a feature is off.",
};

/** The description every surface shows for an Action: its kind, then its note when it has one. */
export function describeAction(action: { name: string; kind: "read" | "write" }, base: string): string {
  const note = actionNotes[action.name];
  return note ? `${base} ${note}` : base;
}
