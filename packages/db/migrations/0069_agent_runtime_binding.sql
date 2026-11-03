ALTER TABLE agents
  ADD COLUMN runtime_id uuid REFERENCES runtimes(id) ON DELETE SET NULL,
  ADD COLUMN cli_model text,
  ADD COLUMN max_concurrent_runs integer NOT NULL DEFAULT 6;
