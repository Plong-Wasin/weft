ALTER TABLE runs
  ADD COLUMN runtime_id uuid REFERENCES runtimes(id) ON DELETE SET NULL,
  ADD COLUMN dispatched_at timestamptz,
  ADD COLUMN final_output text;

CREATE TABLE run_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL UNIQUE REFERENCES runs(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
