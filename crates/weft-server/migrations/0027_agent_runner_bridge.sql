CREATE TABLE ai_runner_pairing_codes (
    id uuid PRIMARY KEY,
    connection_id uuid NOT NULL REFERENCES ai_connections(id) ON DELETE CASCADE,
    owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash text NOT NULL UNIQUE,
    expires_at timestamptz NOT NULL,
    used_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ai_runner_pairing_codes_expiry ON ai_runner_pairing_codes(expires_at) WHERE used_at IS NULL;

CREATE TABLE ai_runners (
    id uuid PRIMARY KEY,
    connection_id uuid NOT NULL REFERENCES ai_connections(id) ON DELETE CASCADE,
    owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name text NOT NULL,
    version text NOT NULL,
    supported_modes text[] NOT NULL DEFAULT '{}',
    token_hash text NOT NULL UNIQUE,
    last_contact_at timestamptz NOT NULL DEFAULT now(),
    revoked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ai_runners_by_connection ON ai_runners(connection_id, created_at DESC);

CREATE TABLE ai_runner_jobs (
    id uuid PRIMARY KEY,
    connection_id uuid NOT NULL REFERENCES ai_connections(id) ON DELETE CASCADE,
    provider_mode text NOT NULL,
    payload jsonb NOT NULL,
    signature text NOT NULL,
    status text NOT NULL CHECK (status IN ('queued','leased','completed','failed','paused')),
    visible_reason text,
    runner_id uuid REFERENCES ai_runners(id) ON DELETE SET NULL,
    lease_expires_at timestamptz,
    result jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (jsonb_typeof(payload)='object'),
    CHECK (result IS NULL OR jsonb_typeof(result)='object')
);

CREATE INDEX ai_runner_jobs_queue ON ai_runner_jobs(connection_id, created_at) WHERE status IN ('queued','paused');
CREATE INDEX ai_runner_jobs_lease ON ai_runner_jobs(lease_expires_at) WHERE status='leased';
