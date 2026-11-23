import { afterEach, expect, test } from "bun:test";
import { resources, setLocale } from "@weft/shared";
import { readFileSync } from "node:fs";
import { cliDeviceApprovalErrorMessage } from "../src/cli-device-approval-error";

afterEach(() => setLocale("en"));

test("load failures use the Thai translated message for fetch and server errors", () => {
  setLocale("th");
  expect(cliDeviceApprovalErrorMessage("load", new Error("Failed to fetch"))).toBe(resources.th["cliDevice.loadFailed"]);
  expect(cliDeviceApprovalErrorMessage("load", new Error("This sign-in request is invalid or expired."))).toBe(resources.th["cliDevice.loadFailed"]);
});

test("decision failures use the Thai translated message for fetch and server errors", () => {
  setLocale("th");
  expect(cliDeviceApprovalErrorMessage("decision", new Error("Failed to fetch"))).toBe(resources.th["cliDevice.decisionFailed"]);
  expect(cliDeviceApprovalErrorMessage("decision", new Error("Device approval was refused."))).toBe(resources.th["cliDevice.decisionFailed"]);
});

test("the page has no hardcoded approval errors and the deny button is at least 44 px tall", () => {
  const page = readFileSync(new URL("../src/pages/cli-device-approval.tsx", import.meta.url), "utf8");
  expect(page).not.toContain("This sign-in request is invalid or expired.");
  expect(page).not.toContain("Could not complete this decision.");
  expect(page).toContain('className="min-h-11 rounded-md border');
});
