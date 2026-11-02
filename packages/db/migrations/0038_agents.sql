ALTER TABLE "user" ADD COLUMN IF NOT EXISTS is_agent boolean NOT NULL DEFAULT false;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id text NOT NULL UNIQUE REFERENCES "user"(id) ON DELETE CASCADE,
  instructions text NOT NULL DEFAULT '',
  model text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  all_projects boolean NOT NULL DEFAULT false,
  max_tool_calls integer NOT NULL DEFAULT 25 CHECK (max_tool_calls > 0),
  max_tokens integer NOT NULL DEFAULT 200000 CHECK (max_tokens > 0),
  timeout_seconds integer NOT NULL DEFAULT 600 CHECK (timeout_seconds > 0),
  monthly_token_budget integer CHECK (monthly_token_budget IS NULL OR monthly_token_budget > 0),
  created_by text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS agents_workspace_id_idx ON agents (workspace_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS agent_projects (
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  PRIMARY KEY (agent_id, project_id)
);
