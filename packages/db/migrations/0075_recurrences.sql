CREATE TABLE recurrences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE, creator_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  name text NOT NULL, template jsonb NOT NULL, schedule text NOT NULL, interval integer NOT NULL DEFAULT 1,
  timezone text NOT NULL DEFAULT 'UTC', status text NOT NULL DEFAULT 'active', next_run_at timestamptz NOT NULL,
  last_run_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX recurrences_project_id_status_idx ON recurrences(project_id, status);
