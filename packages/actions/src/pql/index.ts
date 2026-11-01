export { PqlError } from "./errors";
export { parse, tokenize, pqlLimits, type Query, type Expr, type Operator, type ValueNode } from "./parser";
export { compilePql, type CompiledPql, type PqlScope } from "./compile";
export { createPqlRegistry, defaultPqlRegistry, defaultFields, defaultFunctions, relationField, resolveNamed } from "./registry";
export { weftPqlRegistry } from "./scope";
export type { PqlContext, PqlField, PqlFunction, PqlRegistry, Operand, Named, ValueType } from "./types";

/** Short syntax reference shown to the AI and the UI. */
export const pqlSyntaxHelp = "Weft query: Field Operator Value, combined with AND, OR, NOT and parentheses, then optional ORDER BY field [ASC|DESC] and LIMIT n (max 1000). "
  + "Fields: title, text, id, state, stateGroup, priority, assignee, label, cycle, module, mention, createdBy, project, startDate, dueDate, createdAt, updatedAt. "
  + "Operators: = != ~ IN NOT IN < <= > >= BETWEEN a AND b, IS NULL, IS NOT NULL. "
  + "Functions: currentUser(), today(), startOfWeek(), endOfWeek(), openStates(), closedStates(), isOverdue(), hasNoAssignee(), hasNoLabel(), activeCycle() (the Cycle active today; cycle and module need those features on). "
  + "Names (state, label, assignee, cycle, module) resolve inside the project; quote names that contain keywords or spaces. "
  + 'Examples: (1) priority IN (urgent, high) AND assignee = currentUser() AND dueDate < today() ORDER BY dueDate LIMIT 20 '
  + '(2) cycle = activeCycle() AND stateGroup != completed AND hasNoAssignee() '
  + '(3) module = "Mobile app" AND label = bug AND cycle IS NULL ORDER BY priority DESC';
