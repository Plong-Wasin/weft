CREATE TABLE IF NOT EXISTS modules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'backlog' CHECK (status IN ('backlog', 'planned', 'in-progress', 'paused', 'completed', 'cancelled')),
  lead_id text REFERENCES "user"(id) ON DELETE SET NULL,
  start_date date,
  end_date date,
  archived_at timestamptz,
  deleted_at timestamptz,
  created_by text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (start_date IS NULL OR end_date IS NULL OR end_date >= start_date)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS modules_project_idx ON modules (project_id, created_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS module_members (
  module_id uuid NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  PRIMARY KEY (module_id, user_id)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS module_items (
  module_id uuid NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  work_item_id uuid NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (module_id, work_item_id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS module_items_work_item_idx ON module_items (work_item_id);
