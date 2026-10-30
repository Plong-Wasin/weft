CREATE TABLE task_references (
    workspace_id uuid NOT NULL,
    target_task_id uuid NOT NULL,
    source_kind text NOT NULL CHECK (source_kind IN ('task_description','comment')),
    source_task_id uuid NOT NULL,
    source_comment_id uuid,
    position integer NOT NULL CHECK (position >= 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((source_kind = 'comment') = (source_comment_id IS NOT NULL)),
    FOREIGN KEY (workspace_id, target_task_id) REFERENCES tasks(workspace_id,id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, source_task_id) REFERENCES tasks(workspace_id,id) ON DELETE CASCADE,
    FOREIGN KEY (source_comment_id) REFERENCES task_comments(id) ON DELETE CASCADE,
    UNIQUE (source_kind, source_task_id, source_comment_id, target_task_id)
);
CREATE INDEX task_references_by_target ON task_references(target_task_id, source_kind, source_task_id);
