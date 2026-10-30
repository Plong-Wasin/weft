CREATE TABLE ai_connections (
    id uuid PRIMARY KEY,
    scope text NOT NULL CHECK (scope IN ('installation', 'workspace', 'personal')),
    workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
    owner_id uuid REFERENCES users(id) ON DELETE CASCADE,
    provider text NOT NULL CHECK (provider IN ('codex', 'claude_code', 'scripted')),
    auth_mode text NOT NULL CHECK (auth_mode IN ('api_key', 'provider_cli', 'organization')),
    billing_mode text NOT NULL CHECK (billing_mode IN ('api', 'subscription', 'organization')),
    credential_reference text,
    runner_reference text,
    model_default text,
    capabilities jsonb NOT NULL DEFAULT '[]'::jsonb,
    limits jsonb NOT NULL DEFAULT '{}'::jsonb,
    state text NOT NULL CHECK (state IN ('ready', 'needs_login', 'unsupported_shared_mode', 'runner_offline', 'disabled')),
    state_reason text NOT NULL,
    enabled boolean NOT NULL DEFAULT true,
    revoked_at timestamptz,
    created_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((scope = 'installation' AND workspace_id IS NULL AND owner_id IS NULL)
        OR (scope = 'workspace' AND workspace_id IS NOT NULL AND owner_id IS NULL)
        OR (scope = 'personal' AND workspace_id IS NULL AND owner_id IS NOT NULL)),
    CHECK (jsonb_typeof(capabilities) = 'array'),
    CHECK (jsonb_typeof(limits) = 'object')
);

CREATE TABLE ai_connection_credentials (
    connection_id uuid PRIMARY KEY REFERENCES ai_connections(id) ON DELETE CASCADE,
    ciphertext bytea NOT NULL,
    key_version smallint NOT NULL DEFAULT 1,
    rotated_at timestamptz NOT NULL DEFAULT now(),
    revoked_at timestamptz
);

CREATE TABLE ai_connection_grants (
    connection_id uuid NOT NULL REFERENCES ai_connections(id) ON DELETE CASCADE,
    workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id uuid REFERENCES users(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((workspace_id IS NOT NULL)::integer + (user_id IS NOT NULL)::integer = 1),
    UNIQUE NULLS NOT DISTINCT (connection_id, workspace_id, user_id)
);

CREATE INDEX ai_connection_grants_by_user ON ai_connection_grants(user_id, connection_id) WHERE user_id IS NOT NULL;
CREATE INDEX ai_connection_grants_by_workspace ON ai_connection_grants(workspace_id, connection_id) WHERE workspace_id IS NOT NULL;

CREATE TABLE ai_default_policies (
    id bigserial PRIMARY KEY,
    scope text NOT NULL CHECK (scope IN ('installation', 'workspace', 'user')),
    workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id uuid REFERENCES users(id) ON DELETE CASCADE,
    connection_id uuid NOT NULL REFERENCES ai_connections(id) ON DELETE CASCADE,
    updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((scope = 'installation' AND workspace_id IS NULL AND user_id IS NULL)
        OR (scope = 'workspace' AND workspace_id IS NOT NULL AND user_id IS NULL)
        OR (scope = 'user' AND workspace_id IS NULL AND user_id IS NOT NULL))
);

CREATE UNIQUE INDEX ai_default_installation ON ai_default_policies(scope) WHERE scope = 'installation';
CREATE UNIQUE INDEX ai_default_workspace ON ai_default_policies(workspace_id) WHERE scope = 'workspace';
CREATE UNIQUE INDEX ai_default_user ON ai_default_policies(user_id) WHERE scope = 'user';
