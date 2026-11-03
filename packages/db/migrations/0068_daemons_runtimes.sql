CREATE TABLE daemons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  hostname text NOT NULL,
  token_id uuid NOT NULL REFERENCES api_tokens(id) ON DELETE CASCADE,
  version text NOT NULL,
  last_heartbeat_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX daemons_token_id_idx ON daemons(token_id);
CREATE TABLE runtimes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  daemon_id uuid NOT NULL REFERENCES daemons(id) ON DELETE CASCADE,
  owner_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  agent_cli text NOT NULL,
  shared boolean NOT NULL DEFAULT false,
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX runtimes_workspace_daemon_cli_idx ON runtimes(workspace_id, daemon_id, agent_cli);
CREATE INDEX runtimes_workspace_shared_idx ON runtimes(workspace_id, shared);
