ALTER TABLE cycles ADD COLUMN history_started_at timestamptz NOT NULL DEFAULT now();
--> statement-breakpoint
CREATE TABLE cycle_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence bigserial NOT NULL UNIQUE,
  cycle_id uuid NOT NULL REFERENCES cycles(id) ON DELETE CASCADE,
  work_item_id uuid,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  kind text NOT NULL,
  member boolean,
  state_group text,
  estimate text,
  previous_start_date date,
  previous_end_date date,
  start_date date,
  end_date date
);
--> statement-breakpoint
CREATE INDEX cycle_history_cycle_time_idx ON cycle_history (cycle_id, occurred_at);
--> statement-breakpoint
CREATE FUNCTION capture_cycle_membership_history() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE wi work_items%ROWTYPE; state_name text; point text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT * INTO wi FROM work_items WHERE id = OLD.work_item_id;
    IF FOUND THEN
      SELECT state_group INTO state_name FROM work_item_states WHERE id = wi.state_id;
      SELECT value INTO point FROM estimate_points WHERE id = wi.estimate_point_id;
    END IF;
    INSERT INTO cycle_history(cycle_id, work_item_id, kind, member, state_group, estimate)
      VALUES (OLD.cycle_id, OLD.work_item_id, 'membership', false, state_name, point);
    RETURN OLD;
  END IF;
  SELECT * INTO wi FROM work_items WHERE id = NEW.work_item_id;
  SELECT state_group INTO state_name FROM work_item_states WHERE id = wi.state_id;
  SELECT value INTO point FROM estimate_points WHERE id = wi.estimate_point_id;
  INSERT INTO cycle_history(cycle_id, work_item_id, kind, member, state_group, estimate)
    VALUES (NEW.cycle_id, NEW.work_item_id, 'membership', true, state_name, point);
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER cycle_items_history_insert AFTER INSERT ON cycle_items FOR EACH ROW
  EXECUTE FUNCTION capture_cycle_membership_history();
--> statement-breakpoint
CREATE TRIGGER cycle_items_history_delete BEFORE DELETE ON cycle_items FOR EACH ROW
  EXECUTE FUNCTION capture_cycle_membership_history();
--> statement-breakpoint
CREATE FUNCTION capture_cycle_transfer_history() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE wi work_items%ROWTYPE; state_name text; point text;
BEGIN
  IF NEW.cycle_id IS NOT DISTINCT FROM OLD.cycle_id THEN RETURN NEW; END IF;
  SELECT * INTO wi FROM work_items WHERE id = NEW.work_item_id;
  SELECT state_group INTO state_name FROM work_item_states WHERE id = wi.state_id;
  SELECT value INTO point FROM estimate_points WHERE id = wi.estimate_point_id;
  INSERT INTO cycle_history(cycle_id, work_item_id, kind, member, state_group, estimate) VALUES
    (OLD.cycle_id, NEW.work_item_id, 'membership', false, state_name, point),
    (NEW.cycle_id, NEW.work_item_id, 'membership', true, state_name, point);
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER cycle_items_history_update AFTER UPDATE OF cycle_id ON cycle_items FOR EACH ROW
  EXECUTE FUNCTION capture_cycle_transfer_history();
--> statement-breakpoint
CREATE FUNCTION capture_cycle_item_changes() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE state_name text; point text;
BEGIN
  IF NEW.state_id IS NOT DISTINCT FROM OLD.state_id AND NEW.estimate_point_id IS NOT DISTINCT FROM OLD.estimate_point_id THEN RETURN NEW; END IF;
  SELECT state_group INTO state_name FROM work_item_states WHERE id = NEW.state_id;
  SELECT value INTO point FROM estimate_points WHERE id = NEW.estimate_point_id;
  INSERT INTO cycle_history(cycle_id, work_item_id, kind, member, state_group, estimate)
    SELECT ci.cycle_id, NEW.id, 'snapshot', true, state_name, point FROM cycle_items ci WHERE ci.work_item_id = NEW.id;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER work_items_cycle_history AFTER UPDATE OF state_id, estimate_point_id ON work_items FOR EACH ROW
  EXECUTE FUNCTION capture_cycle_item_changes();
--> statement-breakpoint
CREATE FUNCTION capture_cycle_point_value_changes() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.value IS NOT DISTINCT FROM OLD.value THEN RETURN NEW; END IF;
  INSERT INTO cycle_history(cycle_id, work_item_id, kind, member, state_group, estimate)
    SELECT ci.cycle_id, wi.id, 'snapshot', true, wis.state_group, NEW.value
      FROM work_items wi
      JOIN cycle_items ci ON ci.work_item_id = wi.id
      JOIN work_item_states wis ON wis.id = wi.state_id
     WHERE wi.estimate_point_id = NEW.id;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER estimate_points_cycle_history AFTER UPDATE OF value ON estimate_points FOR EACH ROW
  EXECUTE FUNCTION capture_cycle_point_value_changes();
--> statement-breakpoint
CREATE FUNCTION capture_cycle_date_changes() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.start_date IS DISTINCT FROM OLD.start_date OR NEW.end_date IS DISTINCT FROM OLD.end_date THEN
    INSERT INTO cycle_history(cycle_id, kind, previous_start_date, previous_end_date, start_date, end_date)
      VALUES (NEW.id, 'dates', OLD.start_date, OLD.end_date, NEW.start_date, NEW.end_date);
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER cycles_history_dates AFTER UPDATE OF start_date, end_date ON cycles FOR EACH ROW
  EXECUTE FUNCTION capture_cycle_date_changes();
--> statement-breakpoint
-- Record what is actually present at the instant history begins; this is a boundary observation, not a backfill.
INSERT INTO cycle_history(cycle_id, work_item_id, occurred_at, kind, member, state_group, estimate)
  SELECT ci.cycle_id, wi.id, c.history_started_at, 'baseline', true, wis.state_group, ep.value
    FROM cycle_items ci
    JOIN cycles c ON c.id = ci.cycle_id
    JOIN work_items wi ON wi.id = ci.work_item_id
    JOIN work_item_states wis ON wis.id = wi.state_id
    LEFT JOIN estimate_points ep ON ep.id = wi.estimate_point_id;
