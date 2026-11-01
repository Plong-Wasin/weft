CREATE INDEX IF NOT EXISTS work_items_project_state_sort_idx ON work_items (project_id, state_id, sort_order);
