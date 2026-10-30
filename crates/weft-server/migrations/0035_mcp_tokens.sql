CREATE TABLE mcp_tokens (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 100),
    token_hash text NOT NULL UNIQUE,
    capabilities text[] NOT NULL CHECK (
        cardinality(capabilities) > 0
        AND capabilities <@ ARRAY['read','generate','split','link']::text[]
    ),
    created_at timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz,
    revoked_at timestamptz
);

CREATE INDEX mcp_tokens_by_user ON mcp_tokens(user_id, workspace_id, created_at DESC);

-- Proposals made through the MCP endpoint hang off a run that has no provider connection.
ALTER TABLE ai_runs ALTER COLUMN connection_id DROP NOT NULL;
ALTER TABLE ai_runs ADD COLUMN mcp_token_id uuid REFERENCES mcp_tokens(id) ON DELETE SET NULL;
