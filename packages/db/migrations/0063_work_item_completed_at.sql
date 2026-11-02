-- A work item remembers when it entered a completed state. Set on entering the completed group, cleared on leaving it;
-- cancelled does not set it. A trigger keeps this in one place, so every surface (UI, AI, CLI, MCP, Intake accept,
-- bulk moves, state deletion) behaves the same.
-- Rollback: DROP TRIGGER IF EXISTS work_items_completed_at ON work_items; DROP FUNCTION IF EXISTS work_items_set_completed_at();
--           DROP INDEX IF EXISTS work_items_completed_idx; ALTER TABLE work_items DROP COLUMN IF EXISTS completed_at;
ALTER TABLE work_items ADD COLUMN IF NOT EXISTS completed_at timestamptz;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION work_items_set_completed_at() RETURNS trigger AS $$
DECLARE
  new_group text;
  old_group text;
BEGIN
  SELECT state_group INTO new_group FROM work_item_states WHERE id = NEW.state_id;
  IF TG_OP = 'INSERT' THEN
    IF new_group = 'completed' THEN NEW.completed_at := COALESCE(NEW.completed_at, now()); ELSE NEW.completed_at := NULL; END IF;
  ELSIF NEW.state_id IS DISTINCT FROM OLD.state_id THEN
    SELECT state_group INTO old_group FROM work_item_states WHERE id = OLD.state_id;
    IF new_group = 'completed' THEN
      IF old_group IS DISTINCT FROM 'completed' OR OLD.completed_at IS NULL THEN NEW.completed_at := now(); END IF;
    ELSE
      NEW.completed_at := NULL;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS work_items_completed_at ON work_items;
--> statement-breakpoint
CREATE TRIGGER work_items_completed_at BEFORE INSERT OR UPDATE OF state_id ON work_items
  FOR EACH ROW EXECUTE FUNCTION work_items_set_completed_at();
--> statement-breakpoint
-- Backfill of existing completed work items: the time of the latest Activity entry that moved the item into its
-- current completed state; an item with no such entry (created in that state, or moved before Activity existed)
-- falls back to its last update time, which is an approximation. Only rows still without a time are touched, so a second run changes nothing.
UPDATE work_items w SET completed_at = COALESCE(
  (SELECT max(a.created_at) FROM activities a
    WHERE a.entity_type = 'work_item' AND a.entity_id = w.id AND a.field = 'state' AND a.new_value = to_jsonb(w.state_id::text)),
  w.updated_at)
FROM work_item_states s
WHERE s.id = w.state_id AND s.state_group = 'completed' AND w.completed_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS work_items_completed_idx ON work_items (project_id, completed_at) WHERE completed_at IS NOT NULL;
