-- A Follow-up Run (ADR 0013) waits in status `follow_up` until its Agent's active Run on the work item ends. It remembers when that active Run began: the comments written since then form its prompt.
ALTER TABLE runs ADD COLUMN follow_up_since timestamptz;
-- At most one Follow-up Run per Agent and work item. `follow_up` is not an active status, so it never blocks the active-Run index (migration 0110).
CREATE UNIQUE INDEX runs_one_follow_up_per_agent_work_item_idx ON runs (agent_id, work_item_id)
  WHERE agent_id IS NOT NULL AND work_item_id IS NOT NULL AND status = 'follow_up';
