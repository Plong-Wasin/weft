ALTER TABLE work_items ADD COLUMN IF NOT EXISTS estimate_point_id uuid REFERENCES estimate_points(id) ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS work_items_estimate_point_idx ON work_items (estimate_point_id) WHERE estimate_point_id IS NOT NULL;
