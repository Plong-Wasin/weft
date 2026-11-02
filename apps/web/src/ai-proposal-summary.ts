const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ProposalField = { key: string; value: string };
export type ProposalSummary = {
  /** First word of the Action name, for example "create". */
  verb: string;
  /** The rest of the Action name in snake_case, for example "work_item". */
  noun: string;
  /** The proposal's own name: title, name or display id. */
  title: string | null;
  /** The project the input points at, so the caller can resolve it to a key. */
  projectId: string | null;
  fields: ProposalField[];
  /** How many input entries the card does not show in full (ids, nested objects, empty values, truncated text), so the caller can point at the exact input. */
  omitted: number;
};

/** "work_item" -> "work item", "assigneeIds" -> "assignee". Used when no translation exists. */
export function humanize(value: string): string {
  return value.replace(/(Ids?)$/, "").replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim().toLowerCase();
}

const MAX_TEXT = 120;

function scalar(value: unknown): string | null {
  if (typeof value === "string") { const text = value.trim(); return text === "" || UUID.test(text) ? null : text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 3)}...` : text; }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

/**
 * Splits a proposed Write action into what a person needs to see: a verb and noun from the Action name, the proposal's title,
 * and its plain fields. Raw ids, nested objects and empty values are left out and counted in `omitted` (as are texts cut short), so the card can point at the exact input; a list of ids shows as a count.
 * Works for any Action name, so an unknown tool still reads as "verb noun" with its fields.
 */
export function summarizeProposal(action: string, input: Record<string, unknown>): ProposalSummary {
  const [verb = action, ...rest] = action.split("_");
  const titleKey = (["title", "name", "displayId"] as const).find((key) => scalar(input[key]) !== null);
  const fields: ProposalField[] = [];
  let omitted = 0;
  // The id of the thing an update/delete/archive acts on is the action's subject, not a dropped detail: it would otherwise make every such card read "+1 more".
  const camel = (value: string) => value.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
  const subjectKeys = verb === "create" ? [] : [`${camel(rest.join("_"))}Id`, `${camel(rest.join("_").replace(/_items$/, ""))}Id`];
  const truncated = (value: unknown) => typeof value === "string" && value.trim().length > MAX_TEXT;
  if (titleKey && truncated(input[titleKey])) omitted++;
  for (const [key, value] of Object.entries(input)) {
    if (key === titleKey || key === "projectId" || key === "workspaceId" || value === undefined) continue;
    if (subjectKeys.includes(key) && typeof value === "string" && UUID.test(value)) continue;
    // Rich content has its own preview on the card.
    if (key === "content" && value !== null && typeof value === "object") continue;
    if (Array.isArray(value)) {
      const parts = value.map(scalar);
      if (value.length > 0 && parts.every((part) => part !== null)) { fields.push({ key, value: parts.join(", ") }); if (value.some(truncated)) omitted++; }
      else if (value.length > 0 && value.every((entry) => typeof entry === "string" && UUID.test(entry))) fields.push({ key, value: String(value.length) });
      else omitted++;
      continue;
    }
    const text = scalar(value);
    if (text !== null) { fields.push({ key, value: text }); if (truncated(value)) omitted++; } else omitted++;
  }
  const projectId = typeof input.projectId === "string" ? input.projectId : null;
  return { verb, noun: rest.join("_"), title: titleKey ? scalar(input[titleKey]) : null, projectId, fields, omitted };
}
