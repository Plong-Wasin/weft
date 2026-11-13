import { expect, test } from "bun:test";
import { accessReasonText } from "../src/access-reason";

test("a greyed-out Agent says who to ask, built from the translated keys", () => {
  expect(accessReasonText({ isAgent: true, hasAccess: false, accessAsk: "owner", accessOwnerName: "Mali" }, "en")).toBe("Ask Mali for access");
  expect(accessReasonText({ isAgent: true, hasAccess: false, accessAsk: "owner", accessOwnerName: "Mali" }, "th")).toContain("Mali");
  expect(accessReasonText({ isAgent: true, hasAccess: false, accessAsk: "owner", accessOwnerName: null }, "en")).toBe("Ask the Runtime owner for access");
  expect(accessReasonText({ isAgent: true, hasAccess: false, accessAsk: "admin" }, "en")).toBe("Ask a workspace Admin for access");
});

test("an older server reply falls back to its English text, and people or usable Agents have no reason", () => {
  expect(accessReasonText({ isAgent: true, hasAccess: false, accessReason: "needs permission from X" }, "en")).toBe("needs permission from X");
  expect(accessReasonText({ isAgent: true, hasAccess: true, accessAsk: "admin" })).toBeNull();
  expect(accessReasonText({ isAgent: false, hasAccess: false, accessAsk: "admin" })).toBeNull();
});
