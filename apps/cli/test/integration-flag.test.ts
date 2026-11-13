import { expect, test } from "bun:test";
import { buildProgram } from "../src/program";

const commandNames = (env: Record<string, string | undefined>) => buildProgram({ env }).commands.map((command) => command.name());

test("the CLI lists the integration commands only with WEFT_INTEGRATIONS_ENABLED=true", () => {
  expect(commandNames({})).not.toContain("list-work-item-pull-requests");
  expect(commandNames({ WEFT_INTEGRATIONS_ENABLED: "false" })).not.toContain("create-work-item-integration");
  expect(commandNames({ WEFT_INTEGRATIONS_ENABLED: "true" })).toContain("list-work-item-pull-requests");
  expect(commandNames({ WEFT_INTEGRATIONS_ENABLED: "true" })).toContain("create-work-item-integration");
});
