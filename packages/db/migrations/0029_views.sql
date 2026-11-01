CREATE TABLE IF NOT EXISTS views (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  query text NOT NULL DEFAULT '',
  layout text NOT NULL DEFAULT 'list' CHECK (layout IN ('list', 'board', 'spreadsheet')),
  group_by text NOT NULL DEFAULT 'state',
  order_by text NOT NULL DEFAULT 'manual',
  order_direction text NOT NULL DEFAULT 'asc' CHECK (order_direction IN ('asc', 'desc')),
  properties jsonb NOT NULL,
  access text NOT NULL DEFAULT 'public' CHECK (access IN ('public', 'private')),
  owner_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS views_project_id_created_at_idx ON views (project_id, created_at);
