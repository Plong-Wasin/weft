CREATE TABLE proposals (
    id uuid PRIMARY KEY,
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    initiator_id uuid NOT NULL REFERENCES users(id),
    scope jsonb NOT NULL,
    schema_version integer NOT NULL DEFAULT 1,
    revision integer NOT NULL DEFAULT 1,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','applied','undone')),
    items jsonb NOT NULL,
    applied_revision integer,
    apply_result jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (workspace_id,id)
);
CREATE TABLE proposal_applications (
    proposal_id uuid NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
    revision integer NOT NULL,
    idempotency_key text NOT NULL,
    result jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (proposal_id,revision),
    UNIQUE (proposal_id,idempotency_key)
);
CREATE TABLE proposal_undo_records (
    proposal_id uuid PRIMARY KEY REFERENCES proposals(id) ON DELETE CASCADE,
    operation_group_id uuid REFERENCES task_operation_groups(id),
    generated_tasks uuid[] NOT NULL DEFAULT '{}',
    relations jsonb NOT NULL DEFAULT '[]',
    skill_changes jsonb NOT NULL DEFAULT '[]',
    schema_items jsonb NOT NULL DEFAULT '[]'
);
