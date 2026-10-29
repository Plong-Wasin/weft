ALTER TABLE workspaces ADD COLUMN next_task_number bigint NOT NULL DEFAULT 1;

CREATE TABLE tasks (
    id uuid PRIMARY KEY,
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    number bigint NOT NULL,
    project_id uuid NOT NULL,
    parent_task_id uuid,
    title text NOT NULL CHECK (length(trim(title)) > 0),
    description text NOT NULL DEFAULT '',
    status text NOT NULL DEFAULT 'backlog' CHECK (status IN ('backlog','not_started','active','completed','canceled')),
    priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
    start_date date,
    due_date date,
    version bigint NOT NULL DEFAULT 1,
    created_by uuid NOT NULL REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    archived_at timestamptz,
    UNIQUE (workspace_id, number),
    UNIQUE (workspace_id, id),
    FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id),
    FOREIGN KEY (workspace_id, parent_task_id) REFERENCES tasks(workspace_id, id)
);

CREATE TABLE task_watchers (
    workspace_id uuid NOT NULL,
    task_id uuid NOT NULL,
    user_id uuid NOT NULL,
    PRIMARY KEY (task_id, user_id),
    FOREIGN KEY (workspace_id, task_id) REFERENCES tasks(workspace_id, id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, user_id) REFERENCES workspace_memberships(workspace_id, user_id) ON DELETE CASCADE
);

CREATE TABLE task_relations (
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    source_task_id uuid NOT NULL,
    target_task_id uuid NOT NULL,
    kind text NOT NULL CHECK (kind IN ('blocks','related','duplicate')),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (source_task_id, target_task_id, kind),
    CHECK (source_task_id <> target_task_id),
    FOREIGN KEY (workspace_id, source_task_id) REFERENCES tasks(workspace_id, id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, target_task_id) REFERENCES tasks(workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX tasks_by_workspace_project ON tasks (workspace_id, project_id, archived_at, number);
CREATE INDEX tasks_by_parent ON tasks (parent_task_id) WHERE parent_task_id IS NOT NULL;
CREATE INDEX task_relations_by_target ON task_relations (target_task_id);
