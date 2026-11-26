/** What an applied Write action changed, worked out from its stored input and result. Titles are never taken from here: they are resolved for the viewer. */
import { paths } from "./routes";

export type TargetKind = "work_item" | "wiki_page" | "cycle" | "module" | "project";
export type TargetRef = { kind: TargetKind; id: string };
export type Target = TargetRef & { ref: string; status: "available" | "archived" | "deleted"; title: string; displayId: string | null; projectKey: string | null; stateGroup: string | null };
export type ResultVerb = "created" | "updated" | "deleted" | "archived" | "restored";
export type AppliedResult = { action: string; verb: ResultVerb; refs: TargetRef[] };

/** `result.id`, `result.workItemId`, `input.workItemIds` and so on: where each action names its target. */
type Source = ["input" | "result", string];
const from = (kind: TargetKind, source: Source, actions: string) => actions.split(" ").map((action) => [action, { kind, source }] as const);
const targets = new Map<string, { kind: TargetKind; source: Source }>([
  ...from("work_item", ["result", "id"], "create_work_item"),
  ...from("work_item", ["result", "workItemId"], "accept_intake_item"),
  ...from("work_item", ["input", "workItemId"], "update_work_item move_work_item delete_work_item archive_work_item restore_work_item restore_work_item_description_version create_comment create_work_item_relation create_web_link"),
  ...from("work_item", ["input", "workItemIds"], "bulk_update_work_items delete_work_items bulk_archive_work_items"),
  ...from("wiki_page", ["result", "id"], "create_wiki_page"),
  ...from("wiki_page", ["input", "pageId"], "update_wiki_page archive_wiki_page unarchive_wiki_page move_wiki_page delete_wiki_page move_page_scope restore_wiki_page_version"),
  ...from("cycle", ["result", "id"], "create_cycle"),
  ...from("cycle", ["input", "cycleId"], "update_cycle add_cycle_items remove_cycle_items archive_cycle unarchive_cycle delete_cycle"),
  ...from("cycle", ["input", "targetCycleId"], "transfer_cycle_items selective_transfer_cycle_items"),
  ...from("module", ["result", "id"], "create_module"),
  ...from("module", ["input", "moduleId"], "update_module add_module_items remove_module_items archive_module unarchive_module delete_module"),
  ...from("project", ["result", "id"], "create_project"),
  ...from("project", ["input", "projectId"], "update_project archive_project unarchive_project rename_project_key join_project add_project_member remove_project_member set_project_features"),
]);

function verbOf(action: string): ResultVerb {
  if (/^create_(work_item|wiki_page|cycle|module|project)$/.test(action)) return "created";
  if (/^delete_(work_items?|wiki_page|cycle|module)$/.test(action)) return "deleted";
  if (/^(bulk_)?archive_/.test(action)) return "archived";
  if (/^(unarchive_|restore_work_item$)/.test(action)) return "restored";
  return "updated";
}

export function appliedResult(action: string, input: unknown, result: unknown): AppliedResult {
  const target = targets.get(action);
  const value = target ? ((target.source[0] === "input" ? input : result) as Record<string, unknown> | null | undefined)?.[target.source[1]] : undefined;
  const ids = (Array.isArray(value) ? value : [value]).filter((id): id is string => typeof id === "string" && id !== "");
  return { action, verb: verbOf(action), refs: ids.map((id) => ({ kind: target!.kind, id })) };
}

/** The Write actions an Autopilot answer already applied, in order. */
export function autopilotResults(parts: Array<{ type: string; input?: unknown; output?: unknown }>): AppliedResult[] {
  return parts.flatMap((part) => isApplied(part) ? [appliedResult(JSON.parse(String(part.output)).action ?? part.type.slice(5), part.input, JSON.parse(String(part.output)).result)] : []);
}

export function isApplied(part: { type: string; output?: unknown }): boolean {
  if (!part.type.startsWith("tool-")) return false;
  try { return (JSON.parse(String(part.output)) as { status?: string }).status === "done"; } catch { return false; }
}

export function targetPath(slug: string, target: Target): string {
  if (target.kind === "work_item") return paths.workItem(slug, target.displayId!);
  if (target.kind === "wiki_page") return target.projectKey ? paths.page(slug, target.projectKey, target.id) : paths.wikiPage(slug, target.id);
  if (target.kind === "cycle") return paths.cycle(slug, target.projectKey!, target.id);
  if (target.kind === "module") return paths.module(slug, target.projectKey!, target.id);
  return paths.workItems(slug, target.projectKey!);
}

/** A Work item display id standing on its own, such as THPMDEV-12. */
export const displayIdPattern = /(?<![A-Za-z0-9_/-])[A-Z][A-Z0-9]{1,11}-\d{1,9}(?![A-Za-z0-9_-])/g;

export const displayIdsIn = (text: string): string[] => [...new Set(text.match(displayIdPattern) ?? [])];
