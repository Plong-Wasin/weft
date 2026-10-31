-- A Milestone is a delivery point of one Project. A Task has at most one Milestone, enforced by a
-- single nullable column; the same-Project rule is checked in the API because it spans two rows.
CREATE TABLE milestones (
    id uuid PRIMARY KEY,
    workspace_id uuid NOT NULL REFERENCES workspaces(id),
    project_id uuid NOT NULL REFERENCES projects(id),
    name text NOT NULL CHECK (length(btrim(name)) > 0),
    description text NOT NULL DEFAULT '',
    target_date date,
    state text NOT NULL DEFAULT 'planned' CHECK (state IN ('planned','active','completed','canceled')),
    version bigint NOT NULL DEFAULT 1,
    created_by uuid REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    archived_at timestamptz
);
CREATE INDEX milestones_project ON milestones(project_id, created_at, id);

ALTER TABLE tasks ADD COLUMN milestone_id uuid REFERENCES milestones(id);
CREATE INDEX tasks_milestone ON tasks(milestone_id) WHERE milestone_id IS NOT NULL;

-- Project-level history of a Milestone (create, edit, state change, archive, restore).
CREATE TABLE milestone_events (
    id uuid PRIMARY KEY,
    milestone_id uuid NOT NULL REFERENCES milestones(id),
    project_id uuid NOT NULL REFERENCES projects(id),
    actor_id uuid REFERENCES users(id),
    kind text NOT NULL,
    before_value jsonb NOT NULL DEFAULT 'null'::jsonb,
    after_value jsonb NOT NULL DEFAULT 'null'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX milestone_events_milestone ON milestone_events(milestone_id, created_at, id);

-- Tasks an archive detached, so a restore can offer to attach them again.
CREATE TABLE milestone_archive_detached (
    milestone_id uuid NOT NULL REFERENCES milestones(id),
    task_id uuid NOT NULL REFERENCES tasks(id),
    PRIMARY KEY (milestone_id, task_id)
);

-- Milestone changes reach every open browser through the same outbox as Task changes. The event
-- carries the Project so the stream drops it for people who cannot read the Project.
CREATE FUNCTION enqueue_milestone_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    change text := lower(TG_OP);
BEGIN
    IF TG_OP = 'UPDATE' AND NEW.archived_at IS NOT NULL AND OLD.archived_at IS NULL THEN change := 'archive'; END IF;
    INSERT INTO realtime_outbox(workspace_id,task_id,project_id,entity_type,entity_id,actor_id,operation_id,entity_version,event_type)
    VALUES(NEW.workspace_id,NULL,NEW.project_id,'milestone',NEW.id,NEW.created_by,gen_random_uuid(),NEW.version,change);
    RETURN NEW;
END $$;
CREATE TRIGGER realtime_milestones AFTER INSERT OR UPDATE ON milestones
    FOR EACH ROW EXECUTE FUNCTION enqueue_milestone_change();
