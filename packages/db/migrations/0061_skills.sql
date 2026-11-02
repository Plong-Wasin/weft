CREATE TABLE skills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  scope text NOT NULL CHECK (scope IN ('personal', 'workspace')),
  owner_id text REFERENCES "user"(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 64 AND name ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  description text NOT NULL CHECK (char_length(description) BETWEEN 1 AND 1024),
  instructions text NOT NULL CHECK (char_length(instructions) BETWEEN 1 AND 8000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((scope = 'personal' AND owner_id IS NOT NULL) OR (scope = 'workspace' AND owner_id IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX skills_personal_name_unique ON skills (workspace_id, owner_id, name) WHERE scope = 'personal';
--> statement-breakpoint
CREATE UNIQUE INDEX skills_workspace_name_unique ON skills (workspace_id, name) WHERE scope = 'workspace';
--> statement-breakpoint
CREATE INDEX skills_workspace_id_scope_idx ON skills (workspace_id, scope);
