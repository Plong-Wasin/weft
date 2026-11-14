import { sql, type SQL } from "drizzle-orm";
import { comments, commentMentions, workItemAssignees, workItemLabels, workItemStates, workItems } from "@weft/db";
import { PqlError } from "./errors";
import type { Operator } from "./parser";
import type { Named, Operand, PqlContext, PqlField, PqlFunction, PqlRegistry } from "./types";

const stateGroupNames = ["backlog", "unstarted", "started", "completed", "cancelled"] as const;
const priorityNames = ["urgent", "high", "medium", "low", "none"] as const;
const openGroups = ["backlog", "unstarted", "started"];
const closedGroups = ["completed", "cancelled"];

const no = sql`false`;
const yes = sql`true`;
const escapeLike = (value: string) => value.replace(/[\\%_]/g, (char) => `\\${char}`);
export const list = (values: string[]) => sql.join(values.map((value) => sql`${value}`), sql`, `);
const negateIf = (negate: boolean, condition: SQL) => (negate ? sql`not (${condition})` : condition);
export const isNegative = (operator: Operator) => operator === "!=" || operator === "NOT IN";

// ---- helpers other tickets reuse to add fields ----

/** Fields where several values mean "any of": = and IN, or != and NOT IN. */
const setOperators = ["=", "!=", "IN", "NOT IN"] as const;

/** Resolves a name inside the project, case-insensitively. A missing or duplicate name is an error that names it. */
export function resolveNamed(entries: Named[], operand: Operand, kind: string): string {
  const wanted = operand.text.toLowerCase();
  const found = entries.filter((entry) => entry.id === operand.text || entry.name.toLowerCase() === wanted || entry.extra?.toLowerCase() === wanted);
  const unique = [...new Map(found.map((entry) => [entry.id, entry])).values()];
  if (unique.length === 0) throw new PqlError(operand.pos, `${kind} ${JSON.stringify(operand.text)} was not found in this project`);
  if (unique.length > 1) throw new PqlError(operand.pos, `${kind} ${JSON.stringify(operand.text)} is ambiguous: ${unique.length} ${kind}s have that name`);
  return unique[0]!.id;
}

/** A field backed by a link table: the work item has (or lacks) a row for one of the resolved ids. */
export function relationField(config: {
  name: string; kind: string; operators?: readonly Operator[]; accepts?: PqlField["accepts"];
  entries(context: PqlContext): Promise<Named[]>;
  /** SQL "the work item has a link to one of these ids", or to any when `ids` is null. */
  linked(ids: string[] | null): SQL;
  order?: PqlField["order"];
}): PqlField {
  return {
    name: config.name, accepts: config.accepts, order: config.order,
    operators: config.operators ?? [...setOperators, "IS NULL", "IS NOT NULL"],
    async compile(context, operator, operands) {
      if (operator === "IS NULL") return sql`not (${config.linked(null)})`;
      if (operator === "IS NOT NULL") return config.linked(null);
      const entries = await config.entries(context);
      const ids = [...new Set(operands.map((operand) => operand.fromFunction ? operand.text : resolveNamed(entries, operand, config.kind)))];
      if (ids.length === 0) return isNegative(operator) ? yes : no;
      return negateIf(isNegative(operator), config.linked(ids));
    },
  };
}

const userField = (config: { name: string; linked: (ids: string[] | null) => SQL; operators?: readonly Operator[]; order?: PqlField["order"] }) =>
  relationField({ ...config, kind: "member", accepts: ["user"], entries: (context) => context.members() });

/** A single-valued column holding a name-resolved id, such as createdBy. */
function columnField(config: { name: string; kind: string; column: SQL; entries(context: PqlContext): Promise<Named[]>; accepts?: PqlField["accepts"]; order?: PqlField["order"] }): PqlField {
  return {
    name: config.name, accepts: config.accepts, order: config.order, operators: setOperators,
    async compile(context, operator, operands) {
      const entries = await config.entries(context);
      const ids = [...new Set(operands.map((operand) => operand.fromFunction ? operand.text : resolveNamed(entries, operand, config.kind)))];
      if (ids.length === 0) return isNegative(operator) ? yes : no;
      return negateIf(isNegative(operator), sql`${config.column} in (${list(ids)})`);
    },
  };
}

// ---- dates ----

function parseDate(operand: Operand): string {
  const parsed = new Date(`${operand.text}T00:00:00Z`);
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(operand.text) && !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === operand.text;
  if (!valid) throw new PqlError(operand.pos, `${JSON.stringify(operand.text)} is not a date; write YYYY-MM-DD or use a function such as today()`);
  return operand.text;
}

const dateOperators = ["=", "!=", "<", "<=", ">", ">=", "BETWEEN", "IS NULL", "IS NOT NULL"] as const;

function dateField(name: string, column: SQL, kind: "date" | "timestamp"): PqlField {
  const day = kind === "date" ? column : sql`((${column} at time zone 'UTC')::date)`;
  return {
    name, operators: dateOperators, accepts: ["date"],
    order: (_context, direction) => [sql`${column} is null`, direction === "asc" ? sql`${column} asc` : sql`${column} desc`],
    compile(_context, operator, operands) {
      if (operator === "IS NULL") return sql`${column} is null`;
      if (operator === "IS NOT NULL") return sql`${column} is not null`;
      const dates = operands.map(parseDate);
      if (operator === "BETWEEN") return sql`(${day} >= ${dates[0]}::date and ${day} <= ${dates[1]}::date)`;
      const symbol = { "=": sql`=`, "!=": sql`<>`, "<": sql`<`, "<=": sql`<=`, ">": sql`>`, ">=": sql`>=` }[operator as "="]!;
      return sql`(${day} ${symbol} ${dates[0]}::date)`;
    },
  };
}

// ---- built-in fields ----

const text = (name: string, columns: SQL[]): PqlField => ({
  name, operators: ["=", "!=", "~"],
  compile(_context, operator, [operand]) {
    const value = operand!.text;
    const pattern = `%${escapeLike(value)}%`;
    const match = operator === "~"
      ? sql.join(columns.map((column) => sql`${column} ilike ${pattern}`), sql` or `)
      : sql.join(columns.map((column) => sql`${column} = ${value}`), sql` or `);
    return operator === "!=" ? sql`not (${match})` : sql`(${match})`;
  },
});

const idField: PqlField = {
  name: "id",
  operators: ["=", "!=", "~", "<", "<=", ">", ">=", "BETWEEN", "IN", "NOT IN"],
  order: (_context, direction) => [direction === "asc" ? sql`${workItems.sequence} asc` : sql`${workItems.sequence} desc`],
  async compile(context, operator, operands) {
    if (operator === "~") {
      return sql`((${context.projectKey} || '-' || ${workItems.sequence}::text) ilike ${`%${escapeLike(operands[0]!.text)}%`})`;
    }
    const keys = await context.keys();
    // Every work item in scope belongs to this project, so an identifier of another project matches nothing.
    const parsed = operands.map((operand) => {
      if (/^[0-9]{1,9}$/.test(operand.text)) return { sequence: Number(operand.text), inProject: true };
      const match = /^([A-Za-z][A-Za-z0-9]*)-([0-9]{1,9})$/.exec(operand.text);
      if (!match) throw new PqlError(operand.pos, `${JSON.stringify(operand.text)} is not a work item id; write WEB-11 or a sequence number`);
      return { sequence: Number(match[2]), inProject: keys.includes(match[1]!.toUpperCase()) };
    });
    const sequences = parsed.filter((entry) => entry.inProject).map((entry) => entry.sequence);
    switch (operator) {
      case "=": case "IN": return sequences.length ? sql`${workItems.sequence} in (${sql.join(sequences.map((value) => sql`${value}`), sql`, `)})` : no;
      case "!=": case "NOT IN": return sequences.length ? sql`${workItems.sequence} not in (${sql.join(sequences.map((value) => sql`${value}`), sql`, `)})` : yes;
      case "BETWEEN": return parsed.every((entry) => entry.inProject) ? sql`(${workItems.sequence} >= ${parsed[0]!.sequence} and ${workItems.sequence} <= ${parsed[1]!.sequence})` : no;
      default: {
        if (!parsed[0]!.inProject) return no;
        const symbol = { "<": sql`<`, "<=": sql`<=`, ">": sql`>`, ">=": sql`>=` }[operator as "<"]!;
        return sql`(${workItems.sequence} ${symbol} ${parsed[0]!.sequence})`;
      }
    }
  },
};

function enumField(name: string, column: SQL, allowed: readonly string[], order?: PqlField["order"], accepts?: PqlField["accepts"]): PqlField {
  return {
    name, operators: setOperators, order, accepts,
    compile(_context, operator, operands) {
      const values = [...new Set(operands.map((operand) => {
        const value = operand.text.toLowerCase();
        if (!allowed.includes(value)) throw new PqlError(operand.pos, `${JSON.stringify(operand.text)} is not a valid ${name}; use one of ${allowed.join(", ")}`);
        return value;
      }))];
      if (values.length === 0) return isNegative(operator) ? yes : no;
      return negateIf(isNegative(operator), sql`${column} in (${list(values)})`);
    },
  };
}

const stateOf = sql`(select s.state_group from ${workItemStates} s where s.id = ${workItems.stateId})`;
const priorityRank = sql`case ${workItems.priority} when 'urgent' then 0 when 'high' then 1 when 'medium' then 2 when 'low' then 3 else 4 end`;

const stateField: PqlField = {
  name: "state", operators: setOperators,
  order: (_context, direction) => [direction === "asc"
    ? sql`(select s.sort_order from ${workItemStates} s where s.id = ${workItems.stateId}) asc`
    : sql`(select s.sort_order from ${workItemStates} s where s.id = ${workItems.stateId}) desc`],
  async compile(context, operator, operands) {
    const entries = await context.states();
    const ids = [...new Set(operands.map((operand) => resolveNamed(entries, operand, "state")))];
    return negateIf(isNegative(operator), sql`${workItems.stateId} in (${list(ids)})`);
  },
};

const assigneeLinked = (ids: string[] | null) => sql`exists (select 1 from ${workItemAssignees} a where a.work_item_id = ${workItems.id}${ids ? sql` and a.user_id in (${list(ids)})` : sql``})`;
const labelLinked = (ids: string[] | null) => sql`exists (select 1 from ${workItemLabels} l where l.work_item_id = ${workItems.id}${ids ? sql` and l.label_id in (${list(ids)})` : sql``})`;
const mentionLinked = (ids: string[] | null) => sql`exists (
  select 1 from ${commentMentions} cm join ${comments} c on c.id = cm.comment_id
  where c.work_item_id = ${workItems.id} and c.deleted_at is null
    and (c.parent_id is null or exists (select 1 from ${comments} pc where pc.id = c.parent_id and pc.deleted_at is null))${ids ? sql` and cm.user_id in (${list(ids)})` : sql``})`;

const firstName = (table: SQL) => (direction: "asc" | "desc") => [direction === "asc" ? sql`${table} asc nulls last` : sql`${table} desc nulls last`];

export const defaultFields: PqlField[] = [
  text("title", [sql`${workItems.title}`]),
  text("text", [sql`${workItems.title}`, sql`${workItems.descriptionText}`]),
  idField,
  stateField,
  enumField("stateGroup", stateOf, stateGroupNames, undefined, ["stateGroup"]),
  enumField("priority", sql`${workItems.priority}`, priorityNames, (_context, direction) => [direction === "asc" ? sql`${priorityRank} asc` : sql`${priorityRank} desc`]),
  userField({
    name: "assignee", linked: assigneeLinked,
    order: (_context, direction) => firstName(sql`(select min(u.name) from ${workItemAssignees} a join "user" u on u.id = a.user_id where a.work_item_id = ${workItems.id})`)(direction),
  }),
  relationField({
    name: "label", kind: "label", linked: labelLinked, entries: (context) => context.labels(),
    order: (_context, direction) => firstName(sql`(select min(l.name) from ${workItemLabels} wl join labels l on l.id = wl.label_id where wl.work_item_id = ${workItems.id})`)(direction),
  }),
  userField({ name: "mention", linked: mentionLinked }),
  columnField({ name: "createdBy", kind: "member", column: sql`${workItems.createdBy}`, entries: (context) => context.members(), accepts: ["user"] }),
  {
    name: "project", operators: setOperators,
    // Work items are listed per project, so the field only tells whether the named project is this one.
    async compile(context, operator, operands) {
      const mine = [context.projectId, context.projectKey].map((value) => value.toLowerCase());
      const names = (await context.keys()).map((key) => key.toLowerCase());
      const matches = operands.some((operand) => mine.includes(operand.text.toLowerCase()) || names.includes(operand.text.toLowerCase()));
      return (isNegative(operator) ? !matches : matches) ? yes : no;
    },
  },
  dateField("startDate", sql`${workItems.startDate}`, "date"),
  dateField("dueDate", sql`${workItems.dueDate}`, "date"),
  dateField("createdAt", sql`${workItems.createdAt}`, "timestamp"),
  dateField("updatedAt", sql`${workItems.updatedAt}`, "timestamp"),
];

// Fields that can be sorted on but have no condition of their own are added here.
const orderOnly: Array<{ name: string; order: NonNullable<PqlField["order"]> }> = [
  { name: "sortOrder", order: (_context, direction) => [direction === "asc" ? sql`${workItems.sortOrder} asc` : sql`${workItems.sortOrder} desc`] },
  { name: "rank", order: (_context, direction) => [direction === "asc" ? sql`${workItems.sortOrder} asc` : sql`${workItems.sortOrder} desc`] },
];

// ---- built-in functions ----

const isoDay = (date: Date) => date.toISOString().slice(0, 10);
const addDays = (day: string, days: number) => isoDay(new Date(new Date(`${day}T00:00:00Z`).getTime() + days * 86_400_000));
/** Weeks run Monday to Sunday. */
const mondayOf = (day: string) => addDays(day, -((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7));

export const defaultFunctions: PqlFunction[] = [
  { name: "currentUser", kind: "value", returns: "user", list: false, evaluate: (context) => [context.userId] },
  { name: "today", kind: "value", returns: "date", list: false, evaluate: (context) => [context.today] },
  { name: "startOfWeek", kind: "value", returns: "date", list: false, evaluate: (context) => [mondayOf(context.today)] },
  { name: "endOfWeek", kind: "value", returns: "date", list: false, evaluate: (context) => [addDays(mondayOf(context.today), 6)] },
  { name: "openStates", kind: "value", returns: "stateGroup", list: true, evaluate: () => openGroups },
  { name: "closedStates", kind: "value", returns: "stateGroup", list: true, evaluate: () => closedGroups },
  {
    name: "isOverdue", kind: "condition",
    compile: (context) => sql`(${workItems.dueDate} < ${context.today}::date and ${stateOf} in (${list(openGroups)}))`,
  },
  { name: "hasNoAssignee", kind: "condition", compile: () => sql`not (${assigneeLinked(null)})` },
  { name: "hasNoLabel", kind: "condition", compile: () => sql`not (${labelLinked(null)})` },
];

/**
 * The registry the compiler reads. Ticket 09 adds `cycle`, `module` and `activeCycle()` by passing extra
 * fields and functions to `createPqlRegistry`; the parser and compiler stay untouched.
 */
export function createPqlRegistry(extra: { fields?: PqlField[]; functions?: PqlFunction[]; dynamic?: PqlRegistry["dynamic"] } = {}): PqlRegistry {
  const fields = new Map<string, PqlField>();
  for (const field of [...defaultFields, ...(extra.fields ?? [])]) fields.set(field.name.toLowerCase(), field);
  for (const entry of orderOnly) if (!fields.has(entry.name.toLowerCase())) fields.set(entry.name.toLowerCase(), { name: entry.name, operators: [], compile: () => no, order: entry.order });
  const functions = new Map<string, PqlFunction>();
  for (const fn of [...defaultFunctions, ...(extra.functions ?? [])]) functions.set(fn.name.toLowerCase(), fn);
  // title sorts case-insensitively like the list sort.
  const title = fields.get("title")!;
  fields.set("title", { ...title, order: (_context, direction) => [direction === "asc" ? sql`lower(${workItems.title}) asc` : sql`lower(${workItems.title}) desc`] });
  return { fields, functions, dynamic: extra.dynamic };
}

export const defaultPqlRegistry = createPqlRegistry();
