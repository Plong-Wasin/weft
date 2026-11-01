ALTER TABLE views ALTER COLUMN project_id DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE views ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'project' CHECK (scope IN ('project', 'workspace'));
--> statement-breakpoint
ALTER TABLE views ADD CONSTRAINT views_scope_project_check CHECK ((scope = 'project') = (project_id IS NOT NULL));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS views_workspace_id_created_at_idx ON views (workspace_id, created_at);
