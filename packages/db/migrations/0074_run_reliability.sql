DROP INDEX IF EXISTS runs_one_active_per_work_item_idx;
CREATE UNIQUE INDEX runs_one_active_per_agent_work_item_idx
  ON runs (agent_id, work_item_id)
  WHERE agent_id IS NOT NULL AND work_item_id IS NOT NULL
    AND status IN ('queued', 'dispatched', 'running', 'waiting_confirmation', 'awaiting_input', 'stopping');
