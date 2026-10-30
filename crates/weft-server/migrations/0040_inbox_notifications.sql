ALTER TABLE notification_intents
    DROP CONSTRAINT notification_intents_reason_check,
    ADD CONSTRAINT notification_intents_reason_check
        CHECK (reason IN ('assigned', 'mentioned', 'replied', 'watched')),
    ADD COLUMN operation_group_id uuid REFERENCES task_operation_groups(id) ON DELETE SET NULL,
    ADD COLUMN source_comment_id uuid REFERENCES task_comments(id) ON DELETE SET NULL,
    ADD COLUMN read_at timestamptz,
    ADD COLUMN dismissed_at timestamptz,
    ADD COLUMN retracted_at timestamptz;

ALTER TABLE task_comments
    ADD COLUMN operation_group_id uuid REFERENCES task_operation_groups(id) ON DELETE SET NULL;

CREATE INDEX notification_intents_by_group ON notification_intents(operation_group_id)
    WHERE operation_group_id IS NOT NULL;

CREATE TABLE task_notification_preferences (
    task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    events text[] NOT NULL DEFAULT '{}',
    muted boolean NOT NULL DEFAULT false,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (task_id, user_id),
    CHECK (events <@ ARRAY['updated','comment','reply','mention','assignment']::text[])
);

CREATE FUNCTION notify_task_watchers_for_operation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    event_name text;
BEGIN
    event_name := CASE
        WHEN NEW.field_key = 'assignees' THEN 'assignment'
        ELSE 'updated'
    END;
    INSERT INTO notification_intents(id, workspace_id, task_id, recipient_id, actor_id, reason, operation_group_id)
    SELECT gen_random_uuid(), t.workspace_id, t.id, w.user_id, g.actor_id,
           'watched', NEW.group_id
    FROM task_watchers w
    JOIN tasks t ON t.id = w.task_id
    JOIN projects p ON p.id = t.project_id
    JOIN task_operation_groups g ON g.id = NEW.group_id
    LEFT JOIN task_notification_preferences pref ON pref.task_id = t.id AND pref.user_id = w.user_id
    WHERE w.task_id = NEW.task_id
      AND w.user_id <> g.actor_id
      AND COALESCE(pref.muted, false) = false
      AND event_name = ANY(COALESCE(pref.events, ARRAY[]::text[]))
      AND (p.visibility='workspace'
           OR EXISTS(SELECT 1 FROM project_memberships pm WHERE pm.project_id=p.id AND pm.user_id=w.user_id AND pm.role IN ('viewer','contributor','manager'))
           OR EXISTS(SELECT 1 FROM project_team_memberships pt JOIN team_memberships tm ON tm.team_id=pt.team_id WHERE pt.project_id=p.id AND tm.user_id=w.user_id AND pt.role IN ('viewer','contributor','manager')));
    IF NEW.field_key = 'assignees' THEN
        INSERT INTO notification_intents(id, workspace_id, task_id, recipient_id, actor_id, reason, operation_group_id)
        SELECT gen_random_uuid(), t.workspace_id, t.id, (assignee->>'id')::uuid, g.actor_id,
               'assigned', NEW.group_id
        FROM tasks t
        JOIN projects p ON p.id = t.project_id
        JOIN task_operation_groups g ON g.id = NEW.group_id
        CROSS JOIN LATERAL jsonb_array_elements(NEW.after_value) assignee
        WHERE t.id = NEW.task_id
          AND assignee->>'type' = 'user'
          AND (assignee->>'id')::uuid <> g.actor_id
          AND (p.visibility='workspace'
               OR EXISTS(SELECT 1 FROM project_memberships pm WHERE pm.project_id=p.id AND pm.user_id=(assignee->>'id')::uuid AND pm.role IN ('viewer','contributor','manager'))
               OR EXISTS(SELECT 1 FROM project_team_memberships pt JOIN team_memberships tm ON tm.team_id=pt.team_id WHERE pt.project_id=p.id AND tm.user_id=(assignee->>'id')::uuid AND pt.role IN ('viewer','contributor','manager')))
          AND NOT EXISTS (
              SELECT 1 FROM jsonb_array_elements(NEW.before_value) previous
              WHERE previous->>'type' = 'user' AND previous->>'id' = assignee->>'id'
          );
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER task_operation_notifies_watchers
AFTER INSERT ON task_operations
FOR EACH ROW EXECUTE FUNCTION notify_task_watchers_for_operation();
