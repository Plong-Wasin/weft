import { eq, sql, type SQL } from "drizzle-orm";
import type { Database } from "@weft/db";
import { labels, projectKeyAliases, projectMembers, projects, users, workItemStates } from "@weft/db";
import { PqlError } from "./errors";
import { parse, pqlLimits, type Expr, type Operator, type ValueNode } from "./parser";
import { defaultPqlRegistry } from "./registry";
import type { Named, Operand, PqlContext, PqlRegistry } from "./types";

export interface PqlScope { workspaceId: string; projectId: string; projectKey: string; userId: string }
export interface CompiledPql { where: SQL | undefined; orderBy: SQL[]; limit: number }

const noValueOperators = new Set<Operator>(["IS NULL", "IS NOT NULL"]);

/** Day as YYYY-MM-DD in UTC. */
const utcDay = (date: Date) => date.toISOString().slice(0, 10);

function createContext(db: Database, scope: PqlScope, now: Date): PqlContext {
  const cache = new Map<string, Promise<unknown>>();
  const once = <T>(key: string, load: () => Promise<T>) => {
    if (!cache.has(key)) cache.set(key, load());
    return cache.get(key) as Promise<T>;
  };
  return {
    db, ...scope, today: utcDay(now),
    keys: () => once("keys", async () => {
      const aliases = await db.select({ key: projectKeyAliases.key }).from(projectKeyAliases).where(eq(projectKeyAliases.projectId, scope.projectId));
      return [scope.projectKey, ...aliases.map((alias) => alias.key)].map((key) => key.toUpperCase());
    }),
    members: () => once<Named[]>("members", async () => (await db.select({ id: users.id, name: users.name, email: users.email }).from(projectMembers)
      .innerJoin(users, eq(users.id, projectMembers.userId)).where(eq(projectMembers.projectId, scope.projectId))).map((row) => ({ id: row.id, name: row.name, extra: row.email }))),
    states: () => once<Named[]>("states", async () => db.select({ id: workItemStates.id, name: workItemStates.name }).from(workItemStates).where(eq(workItemStates.projectId, scope.projectId))),
    labels: () => once<Named[]>("labels", async () => db.select({ id: labels.id, name: labels.name }).from(labels).where(eq(labels.projectId, scope.projectId))),
  };
}

/**
 * Parses a query and compiles it to parameterised SQL over the work_items table. User text only ever
 * reaches the database as a bound parameter; field, operator and function names come from the registry.
 * The caller supplies project access and the shared listing conditions, then ANDs `where` with them.
 */
export async function compilePql(db: Database, scope: PqlScope, source: string, options: { registry?: PqlRegistry; now?: Date } = {}): Promise<CompiledPql> {
  const registry = options.registry ?? defaultPqlRegistry;
  const context = createContext(db, scope, options.now ?? new Date());
  const query = parse(source);

  async function operandsOf(fieldName: string, accepts: readonly string[], operator: Operator, nodes: ValueNode[]): Promise<Operand[]> {
    const operands: Operand[] = [];
    for (const node of nodes) {
      if (node.kind === "literal") { operands.push({ text: node.text, pos: node.pos, quoted: node.quoted, fromFunction: null }); continue; }
      const fn = registry.functions.get(node.name.toLowerCase());
      if (!fn) throw new PqlError(node.pos, `unknown function ${node.name}()`);
      if (fn.kind !== "value") throw new PqlError(node.pos, `${fn.name}() is a condition; use it on its own, not as a value`);
      if (!accepts.includes(fn.returns)) throw new PqlError(node.pos, `${fn.name}() returns ${fn.returns} values, which ${fieldName} does not accept`);
      const isList = operator === "IN" || operator === "NOT IN";
      if (fn.list && !isList) throw new PqlError(node.pos, `${fn.name}() returns a list; use it with IN`);
      for (const text of await fn.evaluate(context)) operands.push({ text, pos: node.pos, quoted: false, fromFunction: fn.returns });
    }
    return operands;
  }

  async function compileExpr(expr: Expr): Promise<SQL> {
    switch (expr.kind) {
      case "and": { const left = await compileExpr(expr.left); return sql`(${left} and ${await compileExpr(expr.right)})`; }
      case "or": { const left = await compileExpr(expr.left); return sql`(${left} or ${await compileExpr(expr.right)})`; }
      case "not": return sql`not (${await compileExpr(expr.expr)})`;
      case "call": {
        const fn = registry.functions.get(expr.name.toLowerCase());
        if (!fn) throw new PqlError(expr.pos, `unknown function ${expr.name}()`);
        if (fn.kind !== "condition") throw new PqlError(expr.pos, `${fn.name}() is a value; compare a field with it, for example dueDate < ${fn.name}()`);
        return fn.compile(context);
      }
      case "condition": {
        const field = registry.fields.get(expr.field.toLowerCase());
        if (!field || field.operators.length === 0) throw new PqlError(expr.pos, `unknown field ${expr.field}`);
        if (!field.operators.includes(expr.operator)) throw new PqlError(expr.operatorPos, `${field.name} does not support ${expr.operator}; use ${field.operators.join(", ")}`);
        const operands = noValueOperators.has(expr.operator) ? [] : await operandsOf(field.name, field.accepts ?? [], expr.operator, expr.values);
        return field.compile(context, expr.operator, operands, expr.operatorPos);
      }
    }
  }

  const where = query.where ? await compileExpr(query.where) : undefined;
  const orderBy: SQL[] = [];
  for (const item of query.orderBy) {
    const field = registry.fields.get(item.field.toLowerCase());
    if (!field) throw new PqlError(item.pos, `unknown field ${item.field}`);
    if (!field.order) throw new PqlError(item.pos, `cannot sort by ${field.name}`);
    orderBy.push(...field.order(context, item.direction));
  }
  return { where, orderBy, limit: query.limit?.value ?? pqlLimits.maxLimit };
}

