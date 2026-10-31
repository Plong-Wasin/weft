-- Manual Task order. `rank` is one number line per Workspace; a Task's place among its siblings
-- (same Project and parent) and inside a Status bucket is its rank order. Gaps of 2^24 let a
-- drag-and-drop take the midpoint of its neighbours; the server renumbers when a gap closes.
-- A rank change is not an edit: it does not bump `version` and writes no History.
ALTER TABLE tasks ADD COLUMN rank bigint NOT NULL DEFAULT 0;

-- The backfill is not a change anyone should be told about.
ALTER TABLE tasks DISABLE TRIGGER realtime_tasks;
UPDATE tasks t SET rank=r.n*16777216
FROM (SELECT id,row_number() OVER (PARTITION BY workspace_id ORDER BY number) AS n FROM tasks) r
WHERE r.id=t.id;
ALTER TABLE tasks ENABLE TRIGGER realtime_tasks;

-- Every insert path (API, import, recurrence, Templates, AI) gets two things without naming them:
-- a rank at the end of the line (creators serialize on the Workspace row through
-- next_task_number, so the max is stable here) and, when no Status is given, the Workspace's
-- default Status (the column default used to be the fixed key `backlog`).
ALTER TABLE tasks ALTER COLUMN status DROP DEFAULT;
CREATE FUNCTION tasks_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.rank = 0 THEN
        SELECT COALESCE(max(rank),0)+16777216 INTO NEW.rank FROM tasks WHERE workspace_id=NEW.workspace_id;
    END IF;
    IF NEW.status IS NULL THEN
        SELECT status_key INTO NEW.status FROM workspace_statuses
        WHERE workspace_id=NEW.workspace_id AND is_default AND archived_at IS NULL;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER tasks_before_insert BEFORE INSERT ON tasks
FOR EACH ROW EXECUTE FUNCTION tasks_before_insert();

CREATE INDEX tasks_by_rank ON tasks (workspace_id, rank, number);
