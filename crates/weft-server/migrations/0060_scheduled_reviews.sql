-- Opt-in scheduled reviews. A Schedule is off until a Workspace Admin enables it, runs as a named
-- execution principal and can only put a Proposal in the approval queue.

-- A service principal is a user row that cannot sign in (its password hash never parses) and
-- whose access comes only from explicit grants.
CREATE TABLE ai_service_principals (
    user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
    revoked_at timestamptz,
    created_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ai_schedules (
    id uuid PRIMARY KEY,
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
    principal_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    connection_id uuid NOT NULL REFERENCES ai_connections(id) ON DELETE CASCADE,
    capability text NOT NULL DEFAULT 'progress_review' CHECK (capability IN ('progress_review')),
    scope jsonb NOT NULL CHECK (jsonb_typeof(scope)='object'),
    frequency jsonb NOT NULL CHECK (jsonb_typeof(frequency)='object'),
    limits jsonb NOT NULL CHECK (jsonb_typeof(limits)='object'),
    state text NOT NULL DEFAULT 'off' CHECK (state IN ('off','active','stopped')),
    stop_reason text CHECK (stop_reason IN ('disabled_by_admin','connection_revoked','connection_unavailable','principal_revoked','access_lost','limit_reached')),
    stop_detail text,
    next_run_at timestamptz,
    last_run_at timestamptz,
    created_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((state='stopped') = (stop_reason IS NOT NULL)),
    CHECK (state<>'active' OR next_run_at IS NOT NULL)
);
CREATE INDEX ai_schedules_due ON ai_schedules(next_run_at) WHERE state='active';
CREATE INDEX ai_schedules_by_workspace ON ai_schedules(workspace_id, created_at);

CREATE TABLE ai_schedule_runs (
    id uuid PRIMARY KEY,
    schedule_id uuid NOT NULL REFERENCES ai_schedules(id) ON DELETE CASCADE,
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    scheduled_for timestamptz NOT NULL,
    state text NOT NULL CHECK (state IN ('started','skipped','blocked','failed')),
    reason text,
    ai_run_id uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (schedule_id, scheduled_for)
);

ALTER TABLE ai_runs ADD COLUMN schedule_id uuid REFERENCES ai_schedules(id) ON DELETE SET NULL;
-- Per-Schedule run lookups (latest run, runs per day, disable) stay index-backed.
CREATE INDEX ai_runs_by_schedule ON ai_runs(schedule_id) WHERE schedule_id IS NOT NULL;
ALTER TABLE ai_schedule_runs ADD FOREIGN KEY (ai_run_id) REFERENCES ai_runs(id) ON DELETE SET NULL;
