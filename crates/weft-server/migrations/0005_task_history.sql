CREATE TABLE task_operation_groups (
    id uuid PRIMARY KEY,
    command_id uuid NOT NULL UNIQUE,
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    actor_id uuid NOT NULL REFERENCES users(id),
    state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','undone','suppressed')),
    undo_reason text,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE task_operations (
    id uuid PRIMARY KEY,
    group_id uuid NOT NULL REFERENCES task_operation_groups(id) ON DELETE CASCADE,
    task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    field_key text NOT NULL,
    before_value jsonb NOT NULL,
    after_value jsonb NOT NULL,
    task_version bigint NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    suppressed boolean NOT NULL DEFAULT false,
    UNIQUE (group_id, task_id, field_key)
);

CREATE INDEX task_operations_by_task ON task_operations(task_id, created_at);
CREATE INDEX task_operation_groups_by_actor ON task_operation_groups(workspace_id, actor_id, created_at DESC);
