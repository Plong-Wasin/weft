import { expect, test } from "bun:test";
import { shouldDowngradeAutopilot } from "../src/autopilot-mode";

const members = [{ userId: "me", role: "Member" }];
test("a resumed Autopilot chat is kept while its permissions are still loading", () => {
  expect(shouldDowngradeAutopilot({ mode: "autopilot", setting: undefined, members: undefined, selfId: "me" })).toBe(false);
  expect(shouldDowngradeAutopilot({ mode: "autopilot", setting: { allowAutopilot: true }, members: undefined, selfId: "me" })).toBe(false);
});
test("Autopilot drops to Build once the workspace disallows it or the user is a Guest", () => {
  expect(shouldDowngradeAutopilot({ mode: "autopilot", setting: { allowAutopilot: false }, members, selfId: "me" })).toBe(true);
  expect(shouldDowngradeAutopilot({ mode: "autopilot", setting: { allowAutopilot: true }, members: [{ userId: "me", role: "Guest" }], selfId: "me" })).toBe(true);
  expect(shouldDowngradeAutopilot({ mode: "autopilot", setting: { allowAutopilot: true }, members, selfId: "me" })).toBe(false);
  expect(shouldDowngradeAutopilot({ mode: "build", setting: { allowAutopilot: false }, members, selfId: "me" })).toBe(false);
});
