-- GitHub and GitLab links: a workspace Admin connects one webhook per provider, lists the repositories it
-- trusts, and pull or merge requests that mention a work item key are linked to that work item.
ALTER TABLE projects ADD COLUMN merged_pr_moves_to_done boolean NOT NULL DEFAULT false;
--> statement-breakpoint
CREATE TABLE work_item_integrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider text NOT NULL,
  -- The webhook secret, sealed with AES-256-GCM (see packages/actions/src/integration-secrets.ts); never returned by an Action.
  secret_sealed text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  created_by text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT work_item_integrations_provider CHECK (provider IN ('github', 'gitlab')),
  CONSTRAINT work_item_integrations_one_per_provider UNIQUE (workspace_id, provider)
);
--> statement-breakpoint
CREATE TABLE work_item_integration_repositories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_id uuid NOT NULL REFERENCES work_item_integrations(id) ON DELETE CASCADE,
  -- GitHub "owner/name" or GitLab "group/project" path, lower-cased for matching.
  full_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT work_item_integration_repositories_unique UNIQUE (integration_id, full_name)
);
--> statement-breakpoint
-- Delivery ids already accepted, so a redelivered or replayed webhook changes nothing.
CREATE TABLE work_item_integration_deliveries (
  integration_id uuid NOT NULL REFERENCES work_item_integrations(id) ON DELETE CASCADE,
  delivery_id text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (integration_id, delivery_id)
);
--> statement-breakpoint
CREATE TABLE work_item_pull_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  work_item_id uuid NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  provider text NOT NULL,
  repository text NOT NULL,
  number integer NOT NULL,
  title text NOT NULL,
  url text NOT NULL,
  state text NOT NULL,
  checks text NOT NULL DEFAULT 'none',
  head_sha text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT work_item_pull_requests_provider CHECK (provider IN ('github', 'gitlab')),
  CONSTRAINT work_item_pull_requests_state CHECK (state IN ('open', 'merged', 'closed')),
  CONSTRAINT work_item_pull_requests_checks CHECK (checks IN ('none', 'pending', 'passing', 'failing')),
  CONSTRAINT work_item_pull_requests_unique UNIQUE (work_item_id, provider, repository, number)
);
--> statement-breakpoint
CREATE INDEX work_item_pull_requests_repo_idx ON work_item_pull_requests(provider, repository, number);
--> statement-breakpoint
-- Activities written by a repository webhook carry source 'integration'.
ALTER TABLE activities DROP CONSTRAINT IF EXISTS activities_source_check;
--> statement-breakpoint
ALTER TABLE activities ADD CONSTRAINT activities_source_check CHECK (source IN ('ui', 'ai', 'ai_autopilot', 'cli', 'mcp', 'agent', 'agent_autopilot', 'integration'));
