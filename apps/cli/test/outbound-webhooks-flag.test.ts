import { expect, test } from "bun:test";
import { buildProgram } from "../src/program";

const commandNames = (env: Record<string, string | undefined>) => buildProgram({ env }).commands.map((command) => command.name());

test("the CLI lists the outbound webhook commands only with WEFT_OUTBOUND_WEBHOOKS_ENABLED=true", () => {
  expect(commandNames({})).not.toContain("create-outbound-webhook");
  expect(commandNames({ WEFT_OUTBOUND_WEBHOOKS_ENABLED: "false" })).not.toContain("create-outbound-webhook");
  expect(commandNames({ WEFT_OUTBOUND_WEBHOOKS_ENABLED: "yes" })).not.toContain("create-outbound-webhook");
  expect(commandNames({ WEFT_OUTBOUND_WEBHOOKS_ENABLED: "true" })).toContain("create-outbound-webhook");
  expect(commandNames({ WEFT_OUTBOUND_WEBHOOKS_ENABLED: "true" })).toContain("list-outbound-webhook-deliveries");
});
