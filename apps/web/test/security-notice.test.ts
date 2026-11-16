import { expect, test } from "bun:test";
import { securityNoticeText } from "../src/security-notice";

test("a notice code becomes a translated sentence, with the reason put in front", () => {
  expect(securityNoticeText("notice:signed_out", "en")).toBe("An admin signed you out of every device. Sign in again to continue.");
  expect(securityNoticeText("notice:password_reset\nLost laptop", "en")).toBe("Reason: Lost laptop. An admin asked you to reset your password. Choose a new password before you continue.");
  expect(securityNoticeText("notice:password_reset", "th")).not.toBe(securityNoticeText("notice:password_reset", "en"));
});

test("an unknown code gets the generic message and an older stored sentence is shown as is", () => {
  expect(securityNoticeText("notice:something_new", "en")).toBe("An admin changed something about your account. Sign in again to continue.");
  expect(securityNoticeText("An admin signed you out of every device.", "en")).toBe("An admin signed you out of every device.");
});
