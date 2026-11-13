-- Project automation: auto-close idle work items and auto-archive done ones. Off until an admin sets a number of days.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS auto_close_after_days integer CHECK (auto_close_after_days BETWEEN 1 AND 3650);--> statement-breakpoint
ALTER TABLE projects ADD COLUMN IF NOT EXISTS auto_close_from_state_ids jsonb NOT NULL DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE projects ADD COLUMN IF NOT EXISTS auto_close_to_state_id uuid REFERENCES work_item_states(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE projects ADD COLUMN IF NOT EXISTS auto_archive_after_days integer CHECK (auto_archive_after_days BETWEEN 1 AND 3650);--> statement-breakpoint
-- The reason an automatic rule gave for a change; null for every other Activity.
ALTER TABLE activities ADD COLUMN IF NOT EXISTS reason text;
--> statement-breakpoint
ALTER TABLE activities DROP CONSTRAINT IF EXISTS activities_source_check;--> statement-breakpoint
ALTER TABLE activities ADD CONSTRAINT activities_source_check CHECK (source IN ('ui', 'ai', 'ai_autopilot', 'cli', 'mcp', 'agent', 'agent_autopilot', 'integration', 'auto_rule'));
