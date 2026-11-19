ALTER TABLE modules ADD COLUMN history_started_at timestamptz NOT NULL DEFAULT now();
--> statement-breakpoint
CREATE TABLE module_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence bigserial NOT NULL UNIQUE,
  module_id uuid NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  work_item_id uuid,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  kind text NOT NULL,
  member boolean,
  state_group text,
  estimate text
);
--> statement-breakpoint
CREATE INDEX module_history_module_time_idx ON module_history (module_id, occurred_at);
--> statement-breakpoint
CREATE FUNCTION capture_module_membership_history() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE wi work_items%ROWTYPE; state_name text; point text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Parent cascades remove the Module and its report together; do not reinsert into a disappearing parent.
    IF NOT EXISTS (SELECT 1 FROM modules WHERE id = OLD.module_id) THEN RETURN OLD; END IF;
    SELECT * INTO wi FROM work_items WHERE id = OLD.work_item_id;
    IF FOUND THEN
      SELECT state_group INTO state_name FROM work_item_states WHERE id = wi.state_id;
      SELECT value INTO point FROM estimate_points WHERE id = wi.estimate_point_id;
    END IF;
    INSERT INTO module_history(module_id, work_item_id, kind, member, state_group, estimate)
      VALUES (OLD.module_id, OLD.work_item_id, 'membership', false, state_name, point);
    RETURN OLD;
  END IF;
  SELECT * INTO wi FROM work_items WHERE id = NEW.work_item_id;
  SELECT state_group INTO state_name FROM work_item_states WHERE id = wi.state_id;
  SELECT value INTO point FROM estimate_points WHERE id = wi.estimate_point_id;
  INSERT INTO module_history(module_id, work_item_id, kind, member, state_group, estimate)
    VALUES (NEW.module_id, NEW.work_item_id, 'membership', true, state_name, point);
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER module_items_history_insert AFTER INSERT ON module_items FOR EACH ROW
  EXECUTE FUNCTION capture_module_membership_history();
--> statement-breakpoint
CREATE TRIGGER module_items_history_delete BEFORE DELETE ON module_items FOR EACH ROW
  EXECUTE FUNCTION capture_module_membership_history();
--> statement-breakpoint
CREATE FUNCTION capture_module_item_changes() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE state_name text; point text;
BEGIN
  IF NEW.state_id IS NOT DISTINCT FROM OLD.state_id AND NEW.estimate_point_id IS NOT DISTINCT FROM OLD.estimate_point_id THEN RETURN NEW; END IF;
  SELECT state_group INTO state_name FROM work_item_states WHERE id = NEW.state_id;
  SELECT value INTO point FROM estimate_points WHERE id = NEW.estimate_point_id;
  INSERT INTO module_history(module_id, work_item_id, kind, member, state_group, estimate)
    SELECT mi.module_id, NEW.id, 'snapshot', true, state_name, point FROM module_items mi WHERE mi.work_item_id = NEW.id;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER work_items_module_history AFTER UPDATE OF state_id, estimate_point_id ON work_items FOR EACH ROW
  EXECUTE FUNCTION capture_module_item_changes();
--> statement-breakpoint
CREATE FUNCTION capture_module_point_value_changes() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.value IS NOT DISTINCT FROM OLD.value THEN RETURN NEW; END IF;
  INSERT INTO module_history(module_id, work_item_id, kind, member, state_group, estimate)
    SELECT mi.module_id, wi.id, 'snapshot', true, wis.state_group, NEW.value
      FROM work_items wi
      JOIN module_items mi ON mi.work_item_id = wi.id
      JOIN work_item_states wis ON wis.id = wi.state_id
     WHERE wi.estimate_point_id = NEW.id;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER estimate_points_module_history AFTER UPDATE OF value ON estimate_points FOR EACH ROW
  EXECUTE FUNCTION capture_module_point_value_changes();
--> statement-breakpoint
-- The first observed state is the coverage boundary, not a claim about any earlier date.
INSERT INTO module_history(module_id, work_item_id, occurred_at, kind, member, state_group, estimate)
  SELECT mi.module_id, wi.id, m.history_started_at, 'baseline', true, wis.state_group, ep.value
    FROM module_items mi
    JOIN modules m ON m.id = mi.module_id
    JOIN work_items wi ON wi.id = mi.work_item_id
    JOIN work_item_states wis ON wis.id = wi.state_id
    LEFT JOIN estimate_points ep ON ep.id = wi.estimate_point_id;
