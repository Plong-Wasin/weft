ALTER TABLE runs ADD COLUMN IF NOT EXISTS rerun_of_id uuid REFERENCES runs(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE runs ADD COLUMN IF NOT EXISTS attempt integer NOT NULL DEFAULT 0;
