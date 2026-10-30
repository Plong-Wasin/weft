CREATE TABLE task_comment_created_tasks (
    workspace_id uuid NOT NULL,
    task_id uuid NOT NULL,
    source_task_id uuid NOT NULL,
    source_comment_id uuid NOT NULL REFERENCES task_comments(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (source_comment_id, task_id),
    FOREIGN KEY (workspace_id, task_id) REFERENCES tasks(workspace_id, id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, source_task_id) REFERENCES tasks(workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX task_comment_created_tasks_by_task ON task_comment_created_tasks(task_id);

CREATE TABLE task_description_mentions (
    workspace_id uuid NOT NULL,
    task_id uuid NOT NULL,
    recipient_id uuid NOT NULL,
    mention_key text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (task_id, recipient_id),
    FOREIGN KEY (workspace_id, task_id) REFERENCES tasks(workspace_id, id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, recipient_id) REFERENCES workspace_memberships(workspace_id, user_id) ON DELETE CASCADE
);

CREATE INDEX task_description_mentions_by_recipient ON task_description_mentions(recipient_id, created_at DESC);
