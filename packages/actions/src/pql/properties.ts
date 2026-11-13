import { sql, type SQL } from "drizzle-orm";
import { workItemPropertyValues, workItems } from "@weft/db";
import { PqlError } from "./errors";
import type { Operator } from "./parser";
import { isNegative, list, resolveNamed } from "./registry";
import type { Named, Operand, PqlContext, PqlField, PqlProperty } from "./types";

/** `type = Bug`: the work item's Work item type, named inside the project. */
export const typeField: PqlField = {
  name: "type", operators: ["=", "!=", "IN", "NOT IN"], accepts: [],
  async compile(context, operator, operands) {
    const entries = await context.types();
    const ids = [...new Set(operands.map((operand) => resolveNamed(entries, operand, "type")))];
    const condition = sql`${workItems.typeId} in (${list(ids)})`;
    return isNegative(operator) ? sql`not (${condition})` : condition;
  },
};

const setOperators: readonly Operator[] = ["=", "!=", "IN", "NOT IN", "IS NULL", "IS NOT NULL"];
const comparison: readonly Operator[] = ["=", "!=", "<", "<=", ">", ">=", "BETWEEN", "IN", "NOT IN", "IS NULL", "IS NOT NULL"];
const textOperators: readonly Operator[] = ["=", "!=", "~", "IS NULL", "IS NOT NULL"];
const numberText = /^-?\d+(\.\d+)?$/;
const dateText = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A custom property field. The value lives in work_item_property_values, so each condition is an EXISTS over that table for this
 * property. An item without a value matches "!=", "NOT IN" and "IS NULL". Option and person names resolve inside the project.
 */
function propertyField(property: PqlProperty): PqlField {
  const kind = property.kind;
  const operators = kind === "text" || kind === "url" ? textOperators
    : kind === "boolean" ? ["=", "!=", "IS NULL", "IS NOT NULL"] as const
    : kind === "number" || kind === "date" ? comparison
    : setOperators;
  const accepts = kind === "date" ? ["date" as const] : kind === "person" ? ["user" as const] : [];
  const has = (value: SQL) => sql`exists (select 1 from ${workItemPropertyValues} v where v.work_item_id = ${workItems.id} and v.property_id = ${property.id}::uuid and ${value})`;
  const none = sql`not exists (select 1 from ${workItemPropertyValues} v where v.work_item_id = ${workItems.id} and v.property_id = ${property.id}::uuid)`;
  const scalar = sql`(v.value #>> '{}')`;

  return {
    name: `property.${property.name}`, operators, accepts,
    async compile(context: PqlContext, operator: Operator, operands: Operand[], operatorPos: number): Promise<SQL> {
      if (operator === "IS NULL") return none;
      if (operator === "IS NOT NULL") return has(sql`true`);
      const negate = isNegative(operator);
      const wrap = (condition: SQL) => (negate ? sql`not (${has(condition)})` : has(condition));
      const texts = operands.map((operand) => operand.text);
      switch (kind) {
        case "text": case "url": {
          if (operator === "~") return has(sql`${scalar} ilike ${`%${texts[0]!.replace(/[\\%_]/g, (char) => `\\${char}`)}%`}`);
          return wrap(sql`lower(${scalar}) = lower(${texts[0]!})`);
        }
        case "number": {
          const numbers = operands.map((operand) => {
            if (!numberText.test(operand.text)) throw new PqlError(operand.pos, `${JSON.stringify(operand.text)} is not a number; ${property.name} holds numbers`);
            return Number(operand.text);
          });
          const value = sql`(${scalar})::numeric`;
          if (operator === "BETWEEN") return has(sql`(${value} >= ${numbers[0]} and ${value} <= ${numbers[1]})`);
          if (operator === "IN" || operator === "NOT IN") return wrap(sql`${value} in (${sql.join(numbers.map((n) => sql`${n}`), sql`, `)})`);
          const symbol = { "=": sql`=`, "!=": sql`<>`, "<": sql`<`, "<=": sql`<=`, ">": sql`>`, ">=": sql`>=` }[operator as "="]!;
          if (operator === "!=") return sql`not (${has(sql`${value} = ${numbers[0]}`)})`;
          return wrap(sql`${value} ${symbol} ${numbers[0]}`);
        }
        case "date": {
          const dates = operands.map((operand) => {
            if (!dateText.test(operand.text)) throw new PqlError(operand.pos, `${JSON.stringify(operand.text)} is not a date; write YYYY-MM-DD or use a function such as today()`);
            return operand.text;
          });
          const value = sql`(${scalar})::date`;
          if (operator === "BETWEEN") return has(sql`(${value} >= ${dates[0]}::date and ${value} <= ${dates[1]}::date)`);
          if (operator === "IN" || operator === "NOT IN") return wrap(sql`${value} in (${sql.join(dates.map((date) => sql`${date}::date`), sql`, `)})`);
          if (operator === "!=") return sql`not (${has(sql`${value} = ${dates[0]}::date`)})`;
          const symbol = { "=": sql`=`, "!=": sql`<>`, "<": sql`<`, "<=": sql`<=`, ">": sql`>`, ">=": sql`>=` }[operator as "="]!;
          return wrap(sql`${value} ${symbol} ${dates[0]}::date`);
        }
        case "boolean": {
          const wanted = texts[0]!.toLowerCase();
          if (wanted !== "true" && wanted !== "false" && wanted !== "yes" && wanted !== "no") throw new PqlError(operands[0]!.pos, `${JSON.stringify(texts[0])} is not yes or no`);
          return wrap(sql`v.value = to_jsonb(${wanted === "true" || wanted === "yes"}::boolean)`);
        }
        case "dropdown": {
          const ids = [...new Set(operands.map((operand) => resolveNamed(property.options, operand, property.name)))];
          return wrap(sql`${scalar} in (${list(ids)})`);
        }
        case "multi_select": {
          const ids = [...new Set(operands.map((operand) => resolveNamed(property.options, operand, property.name)))];
          return wrap(sql`exists (select 1 from jsonb_array_elements_text(v.value) e where e in (${list(ids)}))`);
        }
        case "person": {
          const members = await context.members();
          const ids = [...new Set(operands.map((operand) => operand.fromFunction ? operand.text : resolveNamed(members, operand, "member")))];
          return wrap(sql`${scalar} in (${list(ids)})`);
        }
        default:
          throw new PqlError(operatorPos, `${property.name} cannot be compared`);
      }
    },
  };
}

/** Resolves `property.<name>` against the project's custom properties; any other unknown name is left to the caller's error. */
export async function resolvePropertyField(context: PqlContext, name: string): Promise<PqlField | undefined> {
  const match = /^property\.(.+)$/i.exec(name);
  if (!match) return undefined;
  const wanted = match[1]!.toLowerCase();
  const found = (await context.properties()).filter((property) => property.name.toLowerCase() === wanted);
  if (found.length === 0) throw new PqlError(0, `unknown property ${match[1]}; the project has no custom property with that name`);
  if (found.length > 1) throw new PqlError(0, `property ${match[1]} is ambiguous`);
  return propertyField(found[0]!);
}
