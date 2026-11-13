import { expect, test } from "bun:test";
import type { Database } from "@weft/db";
import { createActionList, integrationActionNames, integrationsEnabled } from "../src";

test("only the exact value true turns the GitHub/GitLab feature on", () => {
  expect(integrationsEnabled({ WEFT_INTEGRATIONS_ENABLED: "true" })).toBe(true);
  for (const value of [undefined, "", "false", "0", "1", "TRUE", "True", "yes", " true"]) {
    expect(integrationsEnabled({ WEFT_INTEGRATIONS_ENABLED: value })).toBe(false);
  }
  expect(integrationsEnabled({})).toBe(false);
});

test("with the flag off the Action list has no integration Actions and keeps every other Action", () => {
  const off = createActionList({} as Database, { integrations: false }).map((action) => action.name);
  const on = createActionList({} as Database, { integrations: true }).map((action) => action.name);
  for (const name of integrationActionNames) {
    expect(off).not.toContain(name);
    expect(on).toContain(name);
  }
  expect(off).toContain("create_work_item");
  expect(off.length + integrationActionNames.length).toBe(on.length);
});
