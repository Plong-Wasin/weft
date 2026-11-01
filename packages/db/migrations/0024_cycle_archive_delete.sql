ALTER TABLE cycles ADD COLUMN IF NOT EXISTS archived_at timestamptz;
--> statement-breakpoint
ALTER TABLE cycles ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
