-- Work item types and custom properties. A project turns the feature on (types_enabled, off by default); every project always
-- has the neutral type Task, which existing work items are moved to. Property values are stored as JSON; clearing one deletes its row.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS types_enabled boolean NOT NULL DEFAULT false;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS work_item_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name text NOT NULL,
  icon text NOT NULL DEFAULT 'task',
  color text NOT NULL DEFAULT '#6b7280',
  description text NOT NULL DEFAULT '',
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS work_item_types_project_name_idx ON work_item_types (project_id, lower(name));
--> statement-breakpoint
INSERT INTO work_item_types (workspace_id, project_id, name, icon, color, description, position)
SELECT p.workspace_id, p.id, 'Task', 'task', '#6b7280', 'The default type for every work item', 0
FROM projects p
WHERE NOT EXISTS (SELECT 1 FROM work_item_types t WHERE t.project_id = p.id);
--> statement-breakpoint
ALTER TABLE work_items ADD COLUMN IF NOT EXISTS type_id uuid REFERENCES work_item_types(id) ON DELETE SET NULL;
--> statement-breakpoint
UPDATE work_items w SET type_id = t.id FROM work_item_types t WHERE t.project_id = w.project_id AND t.position = 0 AND w.type_id IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS work_items_type_idx ON work_items (type_id) WHERE type_id IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS custom_properties (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('text', 'number', 'date', 'boolean', 'url', 'dropdown', 'multi_select', 'person')),
  required boolean NOT NULL DEFAULT false,
  default_value jsonb,
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS custom_properties_project_name_idx ON custom_properties (project_id, lower(name));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS custom_property_options (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES custom_properties(id) ON DELETE CASCADE,
  label text NOT NULL,
  position integer NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS custom_property_options_property_idx ON custom_property_options (property_id, position);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS custom_property_types (
  property_id uuid NOT NULL REFERENCES custom_properties(id) ON DELETE CASCADE,
  type_id uuid NOT NULL REFERENCES work_item_types(id) ON DELETE CASCADE,
  PRIMARY KEY (property_id, type_id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS custom_property_types_type_idx ON custom_property_types (type_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS work_item_property_values (
  work_item_id uuid NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  property_id uuid NOT NULL REFERENCES custom_properties(id) ON DELETE CASCADE,
  value jsonb NOT NULL,
  PRIMARY KEY (work_item_id, property_id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS work_item_property_values_property_idx ON work_item_property_values (property_id);
