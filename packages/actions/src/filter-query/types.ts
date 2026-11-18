import type { SQL } from "drizzle-orm";
import type { Database } from "@weft/db";
import type { Operator } from "./parser";

/** What a value function returns; a field lists the types it accepts so `assignee = today()` is rejected. */
export type ValueType = "date" | "user" | "stateGroup" | "cycle" | "module";

export interface Named { id: string; name: string; extra?: string }

/** Everything a field or function may need while a query is compiled. Lookups are cached per query. */
export interface FilterQueryContext {
  db: Database;
  userId: string;
  workspaceId: string;
  projectId: string;
  projectKey: string;
  /** Today as YYYY-MM-DD in UTC. */
  today: string;
  /** Project key plus every old key (alias) of the project, upper case. */
  keys(): Promise<string[]>;
  members(): Promise<Named[]>;
  states(): Promise<Named[]>;
  labels(): Promise<Named[]>;
  /** The Work item types of the project, by name. */
  types(): Promise<Named[]>;
  /** The custom properties of the project with their kinds and options (option names resolve through `options`). */
  properties(): Promise<FilterQueryProperty[]>;
}

/** A custom property as a query sees it: `property.<name>` compares its values. */
export interface FilterQueryProperty { id: string; name: string; kind: string; options: Named[] }

/** One resolved value: typed text from a literal, or one item of a function result. */
export interface Operand { text: string; pos: number; quoted: boolean; fromFunction: ValueType | null }

export interface FilterQueryField {
  name: string;
  operators: readonly Operator[];
  /** Function value types this field accepts on its right side. */
  accepts?: readonly ValueType[];
  /** Builds the SQL condition. `operands` is empty for IS NULL and IS NOT NULL. Throw FilterQueryError for a bad value. */
  compile(context: FilterQueryContext, operator: Operator, operands: Operand[], operatorPos: number): Promise<SQL> | SQL;
  /** SQL ORDER BY terms; a field without it cannot be sorted on. */
  order?(context: FilterQueryContext, direction: "asc" | "desc"): SQL[];
}

export type FilterQueryFunction =
  | { name: string; kind: "value"; returns: ValueType; list: boolean; evaluate(context: FilterQueryContext): Promise<string[]> | string[] }
  | { name: string; kind: "condition"; compile(context: FilterQueryContext): Promise<SQL> | SQL };

export interface FilterQueryRegistry {
  fields: Map<string, FilterQueryField>;
  functions: Map<string, FilterQueryFunction>;
  /** Resolves names that are not fixed fields, such as `property.severity`; undefined means unknown. */
  dynamic?(context: FilterQueryContext, name: string): Promise<FilterQueryField | undefined>;
}
