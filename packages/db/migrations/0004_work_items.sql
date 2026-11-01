ALTER TABLE projects ADD COLUMN IF NOT EXISTS work_item_sequence integer NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS work_item_states (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name text NOT NULL,
  state_group text NOT NULL CHECK (state_group IN ('backlog', 'unstarted', 'started', 'completed', 'cancelled')),
  sort_order integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, name)
);
--> statement-breakpoint
INSERT INTO work_item_states (workspace_id, project_id, name, state_group, sort_order)
SELECT p.workspace_id, p.id, d.name, d.state_group, 0
FROM projects p CROSS JOIN (VALUES ('Backlog', 'backlog'), ('Todo', 'unstarted'), ('In Progress', 'started'), ('Done', 'completed'), ('Cancelled', 'cancelled')) AS d(name, state_group)
ON CONFLICT DO NOTHING;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS work_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  sequence integer NOT NULL,
  title text NOT NULL,
  description jsonb,
  description_text text NOT NULL DEFAULT '',
  state_id uuid NOT NULL REFERENCES work_item_states(id),
  priority text NOT NULL DEFAULT 'none' CHECK (priority IN ('urgent', 'high', 'medium', 'low', 'none')),
  sort_order double precision NOT NULL,
  created_by text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (project_id, sequence)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS work_items_project_sort_idx ON work_items (project_id, sort_order);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS activities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  entity_type text NOT NULL CHECK (entity_type IN ('work_item', 'state')),
  entity_id uuid NOT NULL,
  field text NOT NULL,
  old_value jsonb,
  new_value jsonb,
  actor_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('ui', 'ai', 'cli', 'mcp')),
  chat_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS activities_entity_idx ON activities (entity_type, entity_id, seq);
