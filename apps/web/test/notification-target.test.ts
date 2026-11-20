import { expect, test } from "bun:test";
import { notificationTarget } from "../src/notification-target";

test("Intake notifications open the item and conversation until acceptance", () => {
  const item = { wikiPageId: null, projectId: "project", projectKey: "MOB", intakeId: "intake-id", intakeOutcome: "pending", displayId: "MOB-2", kind: "mention", commentId: "comment-id" };
  expect(notificationTarget("team", item)).toBe("/team/projects/MOB/intake?currentTab=open&inboxIssueId=intake-id#comment-comment-id");
  expect(notificationTarget("team", { ...item, intakeOutcome: "snoozed" })).toContain("currentTab=open");
  expect(notificationTarget("team", { ...item, intakeOutcome: "rejected" })).toContain("currentTab=closed");
  expect(notificationTarget("team", { ...item, intakeOutcome: "duplicate" })).toContain("currentTab=closed");
  expect(notificationTarget("team", { ...item, intakeOutcome: "accepted" })).toBe("/team/browse/MOB-2#comment-comment-id");
});
