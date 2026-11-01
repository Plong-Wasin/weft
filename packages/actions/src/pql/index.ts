export { PqlError } from "./errors";
export { parse, tokenize, pqlLimits, type Query, type Expr, type Operator, type ValueNode } from "./parser";
export { compilePql, type CompiledPql, type PqlScope } from "./compile";
export { createPqlRegistry, defaultPqlRegistry, defaultFields, defaultFunctions, relationField, resolveNamed } from "./registry";
export type { PqlContext, PqlField, PqlFunction, PqlRegistry, Operand, Named, ValueType } from "./types";

/** Short syntax reference shown to the AI and the UI. */
export const pqlSyntaxHelp = "Weft query: Field Operator Value, combined with AND, OR, NOT and parentheses, then optional ORDER BY field [ASC|DESC] and LIMIT n (max 1000). "
  + "Fields: title, text, id, state, stateGroup, priority, assignee, label, mention, createdBy, project, startDate, dueDate, createdAt, updatedAt. "
  + "Operators: = != ~ IN NOT IN < <= > >= BETWEEN a AND b, IS NULL, IS NOT NULL. "
  + "Functions: currentUser(), today(), startOfWeek(), endOfWeek(), openStates(), closedStates(), isOverdue(), hasNoAssignee(), hasNoLabel(). "
  + 'Names (state, label, assignee) resolve inside the project; quote names that contain keywords. Example: priority IN (urgent, high) AND assignee = currentUser() AND dueDate < today() ORDER BY dueDate LIMIT 20';
