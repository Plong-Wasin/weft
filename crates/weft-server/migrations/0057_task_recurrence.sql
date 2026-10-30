-- A recurrence rule lives beside its Task. Completing the Task creates the next occurrence (with its own
-- copy of the rule) in the same Operation; spawned_task_id remembers that occurrence so a re-completion
-- after Undo never creates a second live one. Dates stay date-only; the Workspace time zone
-- (workspaces.time_zone, migration 0061) decides what "today" is for a Task without dates.
CREATE TABLE task_recurrences (
    task_id uuid PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    frequency text NOT NULL CHECK (frequency IN ('daily','weekly','monthly')),
    -- ISO weekdays, 1 = Monday .. 7 = Sunday, for weekly rules.
    weekdays smallint[] NOT NULL DEFAULT '{}',
    -- Day of the month 1..31 for monthly rules; a short month uses its last day. NULL with
    -- last_day_of_month = true means "the last day of every month".
    month_day smallint CHECK (month_day IS NULL OR month_day BETWEEN 1 AND 31),
    last_day_of_month boolean NOT NULL DEFAULT false,
    spawned_task_id uuid REFERENCES tasks(id) ON DELETE SET NULL,
    created_by uuid NOT NULL REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (frequency <> 'weekly' OR cardinality(weekdays) > 0),
    CHECK (frequency <> 'monthly' OR last_day_of_month OR month_day IS NOT NULL)
);

CREATE INDEX task_recurrences_by_workspace ON task_recurrences (workspace_id);
