ALTER TABLE task_comments
    ADD CONSTRAINT task_comments_workspace_task_id_key UNIQUE (workspace_id, task_id, id);

ALTER TABLE task_attachments
    ADD COLUMN comment_id uuid,
    ADD COLUMN storage_key uuid NOT NULL DEFAULT gen_random_uuid();

ALTER TABLE task_attachments
    ADD CONSTRAINT task_attachments_comment_same_task_fk
        FOREIGN KEY (workspace_id, task_id, comment_id)
        REFERENCES task_comments(workspace_id, task_id, id);

CREATE UNIQUE INDEX task_attachments_storage_key ON task_attachments(storage_key);
CREATE INDEX task_attachments_by_comment ON task_attachments(comment_id, id)
    WHERE comment_id IS NOT NULL;
