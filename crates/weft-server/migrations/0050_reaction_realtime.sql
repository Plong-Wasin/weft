-- A reaction is comment-level data without an Operation. It still has to reach every open browser,
-- so a change to it queues the same event as an edit of its comment.
CREATE FUNCTION enqueue_reaction_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    reaction task_comment_reactions%ROWTYPE;
    project uuid;
    version bigint;
BEGIN
    IF TG_OP = 'DELETE' THEN reaction := OLD; ELSE reaction := NEW; END IF;
    SELECT t.project_id INTO project FROM tasks t WHERE t.id=reaction.task_id;
    SELECT COALESCE((to_jsonb(c)->>'version')::bigint,1) INTO version FROM task_comments c WHERE c.id=reaction.comment_id;
    IF project IS NULL OR version IS NULL THEN RETURN NULL; END IF;
    INSERT INTO realtime_outbox(workspace_id,task_id,project_id,entity_type,entity_id,actor_id,operation_id,entity_version,event_type)
    VALUES(reaction.workspace_id,reaction.task_id,project,'comment',reaction.comment_id,reaction.user_id,gen_random_uuid(),version,'update');
    RETURN NULL;
END $$;
CREATE TRIGGER realtime_comment_reactions AFTER INSERT OR DELETE ON task_comment_reactions
    FOR EACH ROW EXECUTE FUNCTION enqueue_reaction_change();
