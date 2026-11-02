ALTER TABLE activities DROP CONSTRAINT IF EXISTS activities_source_check;
--> statement-breakpoint
ALTER TABLE activities ADD CONSTRAINT activities_source_check CHECK (source IN ('ui', 'ai', 'cli', 'mcp', 'agent'));
--> statement-breakpoint
ALTER TABLE activities ADD COLUMN IF NOT EXISTS run_id uuid REFERENCES runs(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE activities ADD COLUMN IF NOT EXISTS originator_id text REFERENCES "user"(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE comments ADD COLUMN IF NOT EXISTS run_id uuid REFERENCES runs(id) ON DELETE SET NULL;
