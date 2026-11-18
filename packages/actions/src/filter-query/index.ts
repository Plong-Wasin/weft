export { FilterQueryError } from "./errors";
export { parse, tokenize, filterQueryLimits, type Query, type Expr, type Operator, type ValueNode } from "./parser";
export { compileFilterQuery, type CompiledFilterQuery, type FilterQueryScope } from "./compile";
export { createFilterQueryRegistry, defaultFilterQueryRegistry, defaultFields, defaultFunctions, relationField, resolveNamed } from "./registry";
export { weftFilterQueryRegistry } from "./scope";
export type { FilterQueryContext, FilterQueryField, FilterQueryFunction, FilterQueryRegistry, Operand, Named, ValueType } from "./types";

/** Short syntax reference shown to the AI and the UI. */
export const filterQuerySyntaxHelp = "Weft query: Field Operator Value, combined with AND, OR, NOT and parentheses, then optional ORDER BY field [ASC|DESC] and LIMIT n (max 1000). "
  + "Fields: title, text, id, state, stateGroup, priority, assignee, label, type, cycle, module, mention, createdBy, project, startDate, dueDate, createdAt, updatedAt, and property.<name> for a custom property of the project. "
  + "Operators: = != ~ IN NOT IN < <= > >= BETWEEN a AND b, IS NULL, IS NOT NULL. "
  + "Functions: currentUser(), today(), startOfWeek(), endOfWeek(), openStates(), closedStates(), isOverdue(), hasNoAssignee(), hasNoLabel(), activeCycle() (the Cycle active today; cycle and module need those features on). "
  + "Names (state, label, type, assignee, cycle, module, options of a property) resolve inside the project; quote names that contain keywords or spaces. "
  + 'Examples: (1) priority IN (urgent, high) AND assignee = currentUser() AND dueDate < today() ORDER BY dueDate LIMIT 20 '
  + '(2) cycle = activeCycle() AND stateGroup != completed AND hasNoAssignee() '
  + '(3) module = "Mobile app" AND label = bug AND cycle IS NULL ORDER BY priority DESC';
