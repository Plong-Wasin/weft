ALTER TABLE work_item_states DROP CONSTRAINT IF EXISTS work_item_states_state_group_check;
--> statement-breakpoint
ALTER TABLE work_item_states ADD CONSTRAINT work_item_states_state_group_check CHECK (state_group IN ('backlog', 'unstarted', 'started', 'completed', 'cancelled', 'triage'));
--> statement-breakpoint
-- A user state already named "Triage" would clash with the system state: rename it first.
UPDATE work_item_states SET name = 'Triage (custom)' WHERE name = 'Triage' AND state_group <> 'triage';
--> statement-breakpoint
INSERT INTO work_item_states (workspace_id, project_id, name, state_group, sort_order)
SELECT p.workspace_id, p.id, 'Triage', 'triage', COALESCE((SELECT max(s.sort_order) FROM work_item_states s WHERE s.project_id = p.id), -1) + 1
FROM projects p
WHERE NOT EXISTS (SELECT 1 FROM work_item_states s WHERE s.project_id = p.id AND s.state_group = 'triage');
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS work_item_states_one_triage_idx ON work_item_states (project_id) WHERE state_group = 'triage';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS intake_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  work_item_id uuid NOT NULL UNIQUE REFERENCES work_items(id) ON DELETE CASCADE,
  outcome text NOT NULL DEFAULT 'pending' CHECK (outcome IN ('pending', 'rejected', 'snoozed', 'accepted', 'duplicate')),
  snoozed_till timestamptz,
  duplicate_to uuid REFERENCES work_items(id) ON DELETE SET NULL,
  created_by text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  decided_by text REFERENCES "user"(id) ON DELETE SET NULL,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS intake_items_project_outcome_idx ON intake_items (project_id, outcome);
