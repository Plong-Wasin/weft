ALTER TABLE work_items ADD COLUMN IF NOT EXISTS parent_id uuid REFERENCES work_items(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE work_items ADD COLUMN IF NOT EXISTS start_date date;
--> statement-breakpoint
ALTER TABLE work_items ADD COLUMN IF NOT EXISTS due_date date;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS work_items_parent_idx ON work_items (parent_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS labels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name text NOT NULL,
  color text NOT NULL DEFAULT '#6b7280',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, name)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS work_item_assignees (
  work_item_id uuid NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  PRIMARY KEY (work_item_id, user_id)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS work_item_labels (
  work_item_id uuid NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  label_id uuid NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  PRIMARY KEY (work_item_id, label_id)
);
--> statement-breakpoint
ALTER TABLE activities DROP CONSTRAINT IF EXISTS activities_entity_type_check;
--> statement-breakpoint
ALTER TABLE activities ADD CONSTRAINT activities_entity_type_check CHECK (entity_type IN ('work_item', 'state', 'label'));
