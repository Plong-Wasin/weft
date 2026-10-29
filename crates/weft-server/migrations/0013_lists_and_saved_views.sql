CREATE TABLE task_lists (
    id uuid PRIMARY KEY,
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name text NOT NULL CHECK (length(trim(name)) > 0),
    kind text NOT NULL CHECK (kind IN ('manual','smart')),
    query jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_by uuid NOT NULL REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (workspace_id, id)
);

CREATE TABLE task_list_memberships (
    workspace_id uuid NOT NULL,
    list_id uuid NOT NULL,
    task_id uuid NOT NULL,
    position integer NOT NULL DEFAULT 0,
    added_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (list_id, task_id),
    FOREIGN KEY (workspace_id, list_id) REFERENCES task_lists(workspace_id, id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, task_id) REFERENCES tasks(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX task_list_memberships_by_task ON task_list_memberships(task_id, list_id);
