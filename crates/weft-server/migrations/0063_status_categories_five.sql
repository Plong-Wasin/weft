-- Status categories become exactly five, fixed: not_started, active, blocked, wont_do, completed.
-- `canceled` is renamed to `wont_do`; Status keys, Task rows and History rows are untouched (they
-- name Status keys, never categories).
ALTER TABLE workspace_statuses DROP CONSTRAINT workspace_statuses_category_check;
UPDATE workspace_statuses SET category='wont_do' WHERE category='canceled';
ALTER TABLE workspace_statuses ADD CONSTRAINT workspace_statuses_category_check
    CHECK (category IN ('not_started','active','blocked','wont_do','completed'));

-- A Status never moves to another category, whoever writes the row.
CREATE FUNCTION workspace_status_category_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.category IS DISTINCT FROM OLD.category THEN
        RAISE EXCEPTION 'status category is fixed' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER workspace_statuses_category_fixed BEFORE UPDATE OF category ON workspace_statuses
FOR EACH ROW EXECUTE FUNCTION workspace_status_category_fixed();

-- New Tasks start in the Workspace's default Status. Existing Workspaces keep `backlog` as the
-- default, so nothing changes for them.
ALTER TABLE workspace_statuses ADD COLUMN is_default boolean NOT NULL DEFAULT false;
UPDATE workspace_statuses SET is_default=true WHERE status_key='backlog';
CREATE UNIQUE INDEX workspace_statuses_one_default ON workspace_statuses(workspace_id) WHERE is_default;
ALTER TABLE workspace_statuses ADD CONSTRAINT workspace_statuses_default_live
    CHECK (NOT is_default OR archived_at IS NULL);

-- A NEW Workspace gets exactly three Statuses.
CREATE OR REPLACE FUNCTION seed_workspace_statuses() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO workspace_statuses(id,workspace_id,status_key,name,category,color,position,is_default)
    VALUES
        (gen_random_uuid(),NEW.id,'todo','Todo','not_started','#64748b',0,true),
        (gen_random_uuid(),NEW.id,'active','In progress','active','#3b82f6',1,false),
        (gen_random_uuid(),NEW.id,'completed','Done','completed','#22c55e',2,false);
    RETURN NEW;
END;
$$;
