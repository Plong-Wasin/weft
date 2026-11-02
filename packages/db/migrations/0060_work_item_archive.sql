ALTER TABLE work_items ADD COLUMN IF NOT EXISTS archived_at timestamptz;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS work_items_archived_idx ON work_items (project_id) WHERE archived_at IS NOT NULL;
