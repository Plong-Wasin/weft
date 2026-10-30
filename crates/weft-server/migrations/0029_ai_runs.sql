CREATE TABLE ai_runs (
    id uuid PRIMARY KEY,
    initiator_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    connection_id uuid NOT NULL REFERENCES ai_connections(id) ON DELETE RESTRICT,
    capability text NOT NULL CHECK (capability IN ('generate','split','link')),
    scope jsonb NOT NULL CHECK (jsonb_typeof(scope)='object'),
    run_limits jsonb NOT NULL CHECK (jsonb_typeof(run_limits)='object'),
    prompt text NOT NULL CHECK (length(prompt)<=16000),
    session_key text NOT NULL,
    state text NOT NULL CHECK (state IN ('queued','running','waiting_for_approval','rate_limited','needs_login','completed','failed','canceled')),
    summary text NOT NULL,
    result jsonb,
    usage jsonb,
    retry_count integer NOT NULL DEFAULT 0 CHECK (retry_count>=0),
    retry_at timestamptz,
    deadline_at timestamptz NOT NULL,
    context_characters integer NOT NULL DEFAULT 0 CHECK (context_characters>=0),
    tool_calls integer NOT NULL DEFAULT 0 CHECK (tool_calls>=0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (result IS NULL OR jsonb_typeof(result)='object'),
    CHECK (usage IS NULL OR jsonb_typeof(usage)='object')
);

CREATE INDEX ai_runs_by_owner ON ai_runs(initiator_id, created_at DESC);
CREATE INDEX ai_runs_active ON ai_runs(state, created_at) WHERE state IN ('queued','running','rate_limited');

CREATE TABLE ai_run_sources (
    run_id uuid NOT NULL REFERENCES ai_runs(id) ON DELETE CASCADE,
    source_kind text NOT NULL,
    source_id text NOT NULL,
    source_label text NOT NULL,
    read_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(run_id, source_kind, source_id)
);

CREATE TABLE ai_run_events (
    id bigserial PRIMARY KEY,
    run_id uuid NOT NULL REFERENCES ai_runs(id) ON DELETE CASCADE,
    kind text NOT NULL CHECK (kind IN ('state','tool','source','usage')),
    summary text NOT NULL CHECK (length(summary)<=500),
    details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details)='object'),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ai_run_events_by_run ON ai_run_events(run_id,id);

ALTER TABLE ai_runner_jobs ADD COLUMN run_id uuid REFERENCES ai_runs(id) ON DELETE CASCADE;
ALTER TABLE ai_runner_jobs ADD COLUMN available_at timestamptz NOT NULL DEFAULT now();
