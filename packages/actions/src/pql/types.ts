import type { SQL } from "drizzle-orm";
import type { Database } from "@weft/db";
import type { Operator } from "./parser";

/** What a value function returns; a field lists the types it accepts so `assignee = today()` is rejected. */
export type ValueType = "date" | "user" | "stateGroup" | "cycle" | "module";

export interface Named { id: string; name: string; extra?: string }

/** Everything a field or function may need while a query is compiled. Lookups are cached per query. */
export interface PqlContext {
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
  properties(): Promise<PqlProperty[]>;
}

/** A custom property as a query sees it: `property.<name>` compares its values. */
export interface PqlProperty { id: string; name: string; kind: string; options: Named[] }

/** One resolved value: typed text from a literal, or one item of a function result. */
export interface Operand { text: string; pos: number; quoted: boolean; fromFunction: ValueType | null }

export interface PqlField {
  name: string;
  operators: readonly Operator[];
  /** Function value types this field accepts on its right side. */
  accepts?: readonly ValueType[];
  /** Builds the SQL condition. `operands` is empty for IS NULL and IS NOT NULL. Throw PqlError for a bad value. */
  compile(context: PqlContext, operator: Operator, operands: Operand[], operatorPos: number): Promise<SQL> | SQL;
  /** SQL ORDER BY terms; a field without it cannot be sorted on. */
  order?(context: PqlContext, direction: "asc" | "desc"): SQL[];
}

export type PqlFunction =
  | { name: string; kind: "value"; returns: ValueType; list: boolean; evaluate(context: PqlContext): Promise<string[]> | string[] }
  | { name: string; kind: "condition"; compile(context: PqlContext): Promise<SQL> | SQL };

export interface PqlRegistry {
  fields: Map<string, PqlField>;
  functions: Map<string, PqlFunction>;
  /** Resolves names that are not fixed fields, such as `property.severity`; undefined means unknown. */
  dynamic?(context: PqlContext, name: string): Promise<PqlField | undefined>;
}
