import { expect, test } from "bun:test";
import { resources } from "@weft/shared";
import { auditFieldLabel, describeAuditValue, humanizeKey } from "../src/audit-describe";

test("every field the server writes has a translated What changed label", () => {
  for (const field of ["action_grants", "runtime_profile", "enforce_sandbox", "profile_created", "profile_updated", "profile_deleted", "updated", "configuration", "shared", "skills"]) {
    expect(auditFieldLabel(field, "en")).not.toBe(auditFieldLabel("something_new", "en"));
    expect(auditFieldLabel(field, "th")).toBeTruthy();
  }
});

test("an unknown field gets the generic label, never a blank cell", () => {
  expect(auditFieldLabel("something_new", "en")).toBe("Other change");
  expect(auditFieldLabel("something_new", "th")).toBe(resources.th["account.field.unknown"]);
});

test("detail shows plain labels and Yes/No instead of raw camelCase pairs", () => {
  expect(describeAuditValue({ maxConcurrentRuns: 6 }, "en")).toBe("Runs at the same time: 6");
  expect(describeAuditValue({ allowExportActions: true, runtimeId: "r1" }, "en")).toBe("May export data: Yes");
  expect(describeAuditValue({ someNewThing: 3 }, "en")).toBe("Some new thing: 3");
  expect(describeAuditValue(false, "en")).toBe("No");
  expect(describeAuditValue(null, "en")).toBe("");
});

test("humanizeKey spaces camelCase and snake_case", () => {
  expect(humanizeKey("maxConcurrentRuns")).toBe("Max concurrent runs");
  expect(humanizeKey("profile_created")).toBe("Profile created");
});
