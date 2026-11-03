import { expect, test } from "bun:test";
import { writeDecision } from "../src/write-gate";

test("the AI Write gate refuses hidden deletes, confirms deletes and Build writes, and runs safe Autopilot writes", () => {
  expect(writeDecision("delete_project", true)).toBe("refused");
  expect(writeDecision("delete_workspace", true)).toBe("refused");
  expect(writeDecision("delete_work_item", true)).toBe("confirmation");
  expect(writeDecision("create_work_item", false)).toBe("confirmation");
  expect(writeDecision("create_work_item", true)).toBe("run");
});
