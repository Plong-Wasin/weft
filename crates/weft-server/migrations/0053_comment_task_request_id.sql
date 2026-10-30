-- A retried create-task-from-comment carries the same request id and returns the Task it made.
ALTER TABLE task_comment_created_tasks
    ADD COLUMN actor_id uuid,
    ADD COLUMN request_id uuid;

CREATE UNIQUE INDEX task_comment_created_tasks_request
    ON task_comment_created_tasks(source_comment_id, actor_id, request_id)
    WHERE request_id IS NOT NULL;
