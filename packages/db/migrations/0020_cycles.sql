ALTER TABLE projects ADD COLUMN IF NOT EXISTS cycles_enabled boolean NOT NULL DEFAULT true;
--> statement-breakpoint
ALTER TABLE projects ADD COLUMN IF NOT EXISTS modules_enabled boolean NOT NULL DEFAULT true;
--> statement-breakpoint
ALTER TABLE projects ADD COLUMN IF NOT EXISTS intake_enabled boolean NOT NULL DEFAULT true;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS cycles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name text NOT NULL,
  start_date date NOT NULL,
  end_date date NOT NULL CHECK (end_date >= start_date),
  created_by text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS cycles_project_start_idx ON cycles (project_id, start_date);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS cycle_items (
  work_item_id uuid PRIMARY KEY REFERENCES work_items(id) ON DELETE CASCADE,
  cycle_id uuid NOT NULL REFERENCES cycles(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS cycle_items_cycle_idx ON cycle_items (cycle_id);
