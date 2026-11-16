-- A Run records the Run whose step woke it and its depth in the Wake chain; a Run a person or schedule started has no waking Run and depth 0.
-- At most one active Run per Agent and work item is already enforced by runs_one_active_per_agent_work_item_idx (migration 0074) for every insert path.
ALTER TABLE runs ADD COLUMN woken_by_run_id uuid REFERENCES runs (id) ON DELETE SET NULL;
ALTER TABLE runs ADD COLUMN depth integer NOT NULL DEFAULT 0;
