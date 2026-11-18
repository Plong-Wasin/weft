import { expect, test } from "bun:test";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@weft/db";
import { agentContentColumns, agentNonContentColumns } from "../src/agent-retirement";

/** Every column that references the user table with a cascading delete, as the schema declares it. */
function cascadingUserColumns() {
  const found = new Set<string>();
  for (const value of Object.values(schema)) {
    if (!(value instanceof PgTable)) continue;
    const config = getTableConfig(value);
    for (const foreignKey of config.foreignKeys) {
      const reference = foreignKey.reference();
      if (reference.foreignTable !== schema.users || foreignKey.onDelete !== "cascade") continue;
      for (const column of reference.columns) found.add(`${config.name}.${column.name}`);
    }
  }
  return found;
}

test("every cascading user reference is either counted as Agent content or listed as not content with a reason", () => {
  const cascading = cascadingUserColumns();
  expect(cascading.size).toBeGreaterThan(0);
  const unclassified = [...cascading].filter((column) => !(column in agentContentColumns) && !(column in agentNonContentColumns));
  expect(unclassified).toEqual([]);
});

test("the classification names only cascading user references that still exist, and each not-content entry says why", () => {
  const cascading = cascadingUserColumns();
  const stale = [...Object.keys(agentContentColumns), ...Object.keys(agentNonContentColumns)].filter((column) => !cascading.has(column));
  expect(stale).toEqual([]);
  const reasonless = Object.entries(agentNonContentColumns).filter(([, reason]) => reason.trim().length === 0).map(([column]) => column);
  expect(reasonless).toEqual([]);
});

test("no column is both counted and listed as not content", () => {
  const both = Object.keys(agentContentColumns).filter((column) => column in agentNonContentColumns);
  expect(both).toEqual([]);
});
