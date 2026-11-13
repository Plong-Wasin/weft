ALTER TABLE runtimes ADD COLUMN enforce_sandbox boolean NOT NULL DEFAULT false;

CREATE TABLE runtime_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  runtime_id uuid NOT NULL REFERENCES runtimes(id) ON DELETE CASCADE,
  name text NOT NULL,
  sandbox text NOT NULL DEFAULT 'full' CHECK (sandbox IN ('full', 'read-only', 'run-folder')),
  filesystem_allowlist jsonb NOT NULL DEFAULT '[]'::jsonb,
  network_allowlist jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT runtime_profiles_runtime_name_unique UNIQUE (runtime_id, name)
);
CREATE INDEX runtime_profiles_runtime_id_idx ON runtime_profiles(runtime_id);

INSERT INTO runtime_profiles (runtime_id, name, sandbox)
SELECT id, 'Full access', 'full' FROM runtimes;

ALTER TABLE agents ADD COLUMN runtime_profile_id uuid REFERENCES runtime_profiles(id) ON DELETE SET NULL;
UPDATE agents a SET runtime_profile_id = p.id
FROM runtime_profiles p WHERE p.runtime_id = a.runtime_id AND p.name = 'Full access';
