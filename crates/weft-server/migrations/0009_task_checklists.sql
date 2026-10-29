CREATE TABLE task_checklist_items (
    id uuid PRIMARY KEY,
    workspace_id uuid NOT NULL,
    task_id uuid NOT NULL,
    title text NOT NULL CHECK (length(trim(title)) > 0),
    checked boolean NOT NULL DEFAULT false,
    position integer NOT NULL DEFAULT 0,
    version bigint NOT NULL DEFAULT 1,
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (workspace_id, task_id) REFERENCES tasks(workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX task_checklist_by_task ON task_checklist_items(task_id, position, created_at);
