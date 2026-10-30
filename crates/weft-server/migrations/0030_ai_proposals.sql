ALTER TABLE proposals DROP CONSTRAINT proposals_status_check;
ALTER TABLE proposals ADD CONSTRAINT proposals_status_check
    CHECK (status IN ('pending','ready','applied','undone'));
ALTER TABLE proposals ADD COLUMN ai_run_id uuid UNIQUE REFERENCES ai_runs(id) ON DELETE SET NULL;
ALTER TABLE proposals ADD COLUMN provider text;
ALTER TABLE proposals ADD COLUMN assumptions jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(assumptions)='array');
ALTER TABLE proposals ADD COLUMN open_questions jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(open_questions)='array');
ALTER TABLE proposals ADD COLUMN expected_versions jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(expected_versions)='object');
