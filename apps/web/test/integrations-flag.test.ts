import { expect, test } from "bun:test";
import { integrationsEnabledNow, integrationsStateNow, setIntegrationsEnabled } from "../src/integrations-flag";
import { webhookUrl } from "../src/api";

test("webhook URLs use the public API base, including same-origin proxy deployments", () => {
  expect(webhookUrl("https://api.example.com/", "/api/webhooks/work-items/github/id")).toBe("https://api.example.com/api/webhooks/work-items/github/id");
  expect(webhookUrl("", "/api/webhooks/work-items/gitlab/id", "https://weft.example.com/")).toBe("https://weft.example.com/api/webhooks/work-items/gitlab/id");
  expect(webhookUrl("https://api.example.com///", "/api/webhooks/work-items/gitlab/id", "https://weft.example.com")).toBe("https://api.example.com/api/webhooks/work-items/gitlab/id");
});

test("the flag is unknown until /api/config answers, so a route can wait instead of redirecting", () => {
  expect(integrationsStateNow()).toBe("unknown");
  expect(integrationsEnabledNow()).toBe(false);
});

test("the web app hides the integration UI until /api/config reports it on, and follows later changes", () => {
  setIntegrationsEnabled(true);
  expect(integrationsEnabledNow()).toBe(true);
  expect(integrationsStateNow()).toBe("on");
  setIntegrationsEnabled(false);
  expect(integrationsEnabledNow()).toBe(false);
  expect(integrationsStateNow()).toBe("off");
});
