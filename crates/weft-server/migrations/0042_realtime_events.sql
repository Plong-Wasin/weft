CREATE TABLE realtime_outbox (
    id bigserial PRIMARY KEY,
    workspace_id uuid NOT NULL,
    task_id uuid,
    project_id uuid,
    entity_type text NOT NULL,
    entity_id uuid NOT NULL,
    actor_id uuid,
    operation_id uuid NOT NULL,
    entity_version bigint NOT NULL,
    event_type text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX realtime_outbox_workspace_id ON realtime_outbox(workspace_id, id);

CREATE FUNCTION enqueue_realtime_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    workspace uuid;
    task uuid;
    project uuid;
    entity uuid;
    version bigint;
    entity_kind text := TG_ARGV[0];
    operation uuid;
BEGIN
    IF TG_OP = 'DELETE' THEN
        workspace := OLD.workspace_id;
        entity := OLD.id;
        version := COALESCE((to_jsonb(OLD)->>'version')::bigint, (to_jsonb(OLD)->>'revision')::bigint, 1);
        IF entity_kind = 'comment' THEN task := OLD.task_id; ELSE task := OLD.id; END IF;
    ELSE
        workspace := NEW.workspace_id;
        entity := NEW.id;
        version := COALESCE((to_jsonb(NEW)->>'version')::bigint, (to_jsonb(NEW)->>'revision')::bigint, 1);
        IF entity_kind = 'comment' THEN task := NEW.task_id; ELSE task := NEW.id; END IF;
    END IF;
    IF entity_kind = 'task' THEN project := COALESCE((to_jsonb(NEW)->>'project_id')::uuid,(to_jsonb(OLD)->>'project_id')::uuid);
    ELSIF task IS NOT NULL THEN SELECT project_id INTO project FROM tasks WHERE id=task;
        IF project IS NULL THEN SELECT project_id INTO project FROM tasks WHERE id=task; END IF;
    END IF;
    SELECT group_id INTO operation FROM task_operations WHERE task_id=task ORDER BY created_at DESC, id DESC LIMIT 1;
    INSERT INTO realtime_outbox(workspace_id,task_id,project_id,entity_type,entity_id,actor_id,operation_id,entity_version,event_type)
    VALUES(workspace,task,project,entity_kind,entity,COALESCE((to_jsonb(NEW)->>'initiator_id')::uuid,(to_jsonb(OLD)->>'initiator_id')::uuid,(to_jsonb(NEW)->>'author_id')::uuid,(to_jsonb(OLD)->>'author_id')::uuid,(to_jsonb(NEW)->>'created_by')::uuid,(to_jsonb(OLD)->>'created_by')::uuid),COALESCE(operation,gen_random_uuid()),version,lower(TG_OP));
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER realtime_tasks AFTER INSERT OR UPDATE OR DELETE ON tasks
    FOR EACH ROW EXECUTE FUNCTION enqueue_realtime_change('task');
CREATE TRIGGER realtime_comments AFTER INSERT OR UPDATE OR DELETE ON task_comments
    FOR EACH ROW EXECUTE FUNCTION enqueue_realtime_change('comment');
CREATE TRIGGER realtime_proposals AFTER INSERT OR UPDATE OR DELETE ON proposals
    FOR EACH ROW EXECUTE FUNCTION enqueue_realtime_change('proposal');
CREATE TRIGGER realtime_runs AFTER INSERT OR UPDATE OR DELETE ON ai_runs
    FOR EACH ROW EXECUTE FUNCTION enqueue_realtime_change('run');

CREATE FUNCTION enqueue_task_operation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    workspace uuid;
    task_version bigint;
BEGIN
    SELECT t.workspace_id,t.version INTO workspace,task_version FROM tasks t WHERE t.id=NEW.task_id;
    IF workspace IS NOT NULL THEN
        INSERT INTO realtime_outbox(workspace_id,task_id,project_id,entity_type,entity_id,operation_id,entity_version,event_type)
        SELECT workspace,NEW.task_id,t.project_id,'task',NEW.task_id,NEW.group_id,task_version,'operation'
        FROM tasks t WHERE t.id=NEW.task_id;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER realtime_task_operations AFTER INSERT ON task_operations
    FOR EACH ROW EXECUTE FUNCTION enqueue_task_operation();
