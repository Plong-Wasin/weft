-- An occurrence remembers which Task it was spawned from. Completing a repeating Task creates the
-- next occurrence only when no live Task was already spawned from it, even after the rule was
-- stopped and set again (which drops task_recurrences.spawned_task_id).
ALTER TABLE tasks ADD COLUMN spawned_from_task_id uuid REFERENCES tasks(id) ON DELETE SET NULL;
UPDATE tasks t SET spawned_from_task_id = r.task_id FROM task_recurrences r WHERE r.spawned_task_id = t.id;
CREATE INDEX tasks_by_spawned_from ON tasks (spawned_from_task_id) WHERE spawned_from_task_id IS NOT NULL;
