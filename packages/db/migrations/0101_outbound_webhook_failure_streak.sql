-- A webhook whose deliveries keep failing is turned off after a streak of failures; an Admin turns it back on.
ALTER TABLE outbound_webhooks ADD COLUMN consecutive_failures integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE outbound_webhooks ADD COLUMN disabled_reason text;
--> statement-breakpoint
-- The delivery table was created empty in this same release.
-- Delivery log retention reads this column to find rows older than the retention window.
CREATE INDEX outbound_webhook_deliveries_created_at_idx ON outbound_webhook_deliveries (created_at);
