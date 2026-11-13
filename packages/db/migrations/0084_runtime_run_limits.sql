ALTER TABLE workspaces
  ADD COLUMN runtime_runs_per_person_per_hour integer NOT NULL DEFAULT 30 CHECK (runtime_runs_per_person_per_hour > 0),
  ADD COLUMN runtime_runs_per_agent_per_hour integer NOT NULL DEFAULT 30 CHECK (runtime_runs_per_agent_per_hour > 0);

ALTER TABLE agents ALTER COLUMN timeout_seconds SET DEFAULT 1800;
