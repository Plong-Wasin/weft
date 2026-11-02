CREATE TABLE IF NOT EXISTS runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  work_item_id uuid NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  agent_id uuid REFERENCES agents(id) ON DELETE SET NULL,
  originator_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'queued',
  input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS runs_work_item_id_idx ON runs (work_item_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS runs_agent_id_status_idx ON runs (agent_id, status);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS runs_one_active_per_work_item_idx ON runs (work_item_id) WHERE status IN ('queued', 'running', 'waiting_confirmation', 'awaiting_input', 'stopping');
