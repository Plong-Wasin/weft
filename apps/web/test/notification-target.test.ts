import { expect, test } from "bun:test";
import { inboxNotificationIdFromSearch, notificationTarget, notificationTargetWithInboxId, withoutInboxNotificationId } from "../src/notification-target";

test("Intake notifications open the item and conversation until acceptance", () => {
  const item = { wikiPageId: null, projectId: "project", projectKey: "MOB", intakeId: "intake-id", intakeOutcome: "pending", displayId: "MOB-2", kind: "mention", commentId: "comment-id" };
  expect(notificationTarget("team", item)).toBe("/team/projects/MOB/intake?currentTab=open&inboxIssueId=intake-id#comment-comment-id");
  expect(notificationTarget("team", { ...item, intakeOutcome: "snoozed" })).toContain("currentTab=open");
  expect(notificationTarget("team", { ...item, intakeOutcome: "rejected" })).toContain("currentTab=closed");
  expect(notificationTarget("team", { ...item, intakeOutcome: "duplicate" })).toContain("currentTab=closed");
  expect(notificationTarget("team", { ...item, intakeOutcome: "accepted" })).toBe("/team/browse/MOB-2#comment-comment-id");
});

test("Inbox destination carries its notification id without losing target query or hash", () => {
  const item = { wikiPageId: null, projectId: "project", projectKey: "MOB", intakeId: "intake-id", intakeOutcome: "pending", displayId: "MOB-2", kind: "mention", commentId: "comment-id" };
  expect(notificationTargetWithInboxId("team", item, "notification-id")).toBe("/team/projects/MOB/intake?currentTab=open&inboxIssueId=intake-id&inboxNotificationId=notification-id#comment-comment-id");
  expect(notificationTargetWithInboxId("team", { ...item, intakeOutcome: "accepted" }, "notification-id")).toBe("/team/browse/MOB-2?inboxNotificationId=notification-id#comment-comment-id");
  expect(inboxNotificationIdFromSearch("?currentTab=open&inboxNotificationId=notification-id")).toBe("notification-id");
  expect(withoutInboxNotificationId("?currentTab=open&inboxNotificationId=notification-id")).toBe("?currentTab=open");
});

test("scheduled Run notifications open the project-permission-checked Run route", () => {
  const scheduled = { wikiPageId: null, runId: "run-id", projectId: "project", projectKey: "MOB", intakeId: null, intakeOutcome: null, displayId: "", kind: "run_skipped", commentId: null };
  expect(notificationTarget("team", scheduled)).toBe("/team/runs/run-id");
  expect(notificationTargetWithInboxId("team", scheduled, "notice-id")).toBe("/team/runs/run-id?inboxNotificationId=notice-id");
});
