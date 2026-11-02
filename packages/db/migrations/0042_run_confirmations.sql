ALTER TABLE confirmations ALTER COLUMN chat_id DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE confirmations ADD COLUMN IF NOT EXISTS run_id uuid REFERENCES runs(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE confirmations ADD COLUMN IF NOT EXISTS tool_call_id text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS confirmations_run_id_idx ON confirmations (run_id);
