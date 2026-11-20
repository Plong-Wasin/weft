import { expect, test } from "bun:test";
import { canDecideIntake } from "../src/intake-permissions";

test("Intake decisions use both workspace and project roles", () => {
  expect(canDecideIntake("Admin", "Guest")).toBe(true);
  expect(canDecideIntake("Admin", null)).toBe(true);
  expect(canDecideIntake("Member", "Admin")).toBe(true);
  expect(canDecideIntake("Member", "Member")).toBe(true);
  expect(canDecideIntake("Member", null)).toBe(false);
  expect(canDecideIntake("Member", "Guest")).toBe(false);
  expect(canDecideIntake("Guest", "Member")).toBe(false);
  expect(canDecideIntake(null, "Admin")).toBe(false);
});
