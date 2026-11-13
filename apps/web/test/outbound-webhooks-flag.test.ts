import { expect, test } from "bun:test";
import { outboundWebhooksEnabledNow, setOutboundWebhooksEnabled } from "../src/outbound-webhooks-flag";

test("the web app shows outbound webhooks only after the server reports the flag on", () => {
  expect(outboundWebhooksEnabledNow()).toBe(false);
  setOutboundWebhooksEnabled(true);
  expect(outboundWebhooksEnabledNow()).toBe(true);
  setOutboundWebhooksEnabled(false);
  expect(outboundWebhooksEnabledNow()).toBe(false);
});
