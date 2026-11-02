ALTER TABLE runs ADD COLUMN IF NOT EXISTS failure_reason text;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS run_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  seq integer NOT NULL,
  type text NOT NULL,
  tool_name text,
  tool_call_id text,
  input jsonb,
  output jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT run_messages_run_id_seq_unique UNIQUE (run_id, seq)
);
