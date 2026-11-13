-- Outbound webhooks: a workspace Admin points signed JSON events (work item created or changed, comment added, Run finished)
-- at an HTTPS receiver. The feature ships off (WEFT_OUTBOUND_WEBHOOKS_ENABLED); these tables stay empty until it is on.
CREATE TABLE outbound_webhooks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  url text NOT NULL,
  -- The signing secret, sealed with AES-256-GCM (see packages/actions/src/integration-secrets.ts); never returned after creation or rotation.
  secret_sealed text NOT NULL,
  events text[] NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_by text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT outbound_webhooks_name_length CHECK (char_length(name) BETWEEN 1 AND 100)
);
--> statement-breakpoint
CREATE TABLE outbound_webhook_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_id uuid NOT NULL REFERENCES outbound_webhooks(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- The idempotency id: the same on every attempt and every redelivery of one event.
  event_id uuid NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  response_status integer,
  response_excerpt text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_attempt_at timestamptz,
  delivered_at timestamptz,
  CONSTRAINT outbound_webhook_deliveries_status CHECK (status IN ('pending', 'retrying', 'succeeded', 'failed')),
  CONSTRAINT outbound_webhook_deliveries_event_unique UNIQUE (webhook_id, event_id)
);
--> statement-breakpoint
CREATE INDEX outbound_webhook_deliveries_webhook_idx ON outbound_webhook_deliveries (webhook_id, created_at DESC);
