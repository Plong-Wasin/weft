CREATE TABLE task_comments (
    id uuid PRIMARY KEY,
    workspace_id uuid NOT NULL,
    task_id uuid NOT NULL,
    author_id uuid NOT NULL REFERENCES users(id),
    request_id uuid NOT NULL,
    body text NOT NULL CHECK (length(trim(body)) > 0 AND length(body) <= 20000),
    created_at timestamptz NOT NULL DEFAULT now(),
    edited_at timestamptz,
    deleted_at timestamptz,
    UNIQUE (task_id, author_id, request_id),
    FOREIGN KEY (workspace_id, task_id) REFERENCES tasks(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX task_comments_by_task ON task_comments(task_id, created_at, id) WHERE deleted_at IS NULL;
CREATE INDEX task_comments_body_trgm ON task_comments USING gin(body public.gin_trgm_ops) WHERE deleted_at IS NULL;
CREATE INDEX tasks_title_trgm ON tasks USING gin(title public.gin_trgm_ops) WHERE archived_at IS NULL;
CREATE INDEX tasks_description_trgm ON tasks USING gin(description public.gin_trgm_ops) WHERE archived_at IS NULL;
CREATE INDEX task_attribute_values_text_trgm ON task_attribute_values USING gin((value::text) public.gin_trgm_ops);

CREATE TABLE task_attachments (
    id uuid PRIMARY KEY,
    workspace_id uuid NOT NULL,
    task_id uuid NOT NULL,
    uploaded_by uuid NOT NULL REFERENCES users(id),
    file_name text NOT NULL,
    content_type text NOT NULL,
    content bytea NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (workspace_id, task_id) REFERENCES tasks(workspace_id, id) ON DELETE CASCADE
);
