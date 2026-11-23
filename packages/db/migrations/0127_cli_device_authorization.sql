CREATE TABLE cli_devices (
  device_id uuid NOT NULL,
  owner_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  hostname text NOT NULL,
  token_id uuid NOT NULL UNIQUE REFERENCES api_tokens(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, device_id)
);

CREATE TABLE cli_device_authorizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id uuid NOT NULL,
  hostname text NOT NULL,
  device_secret_hash text NOT NULL UNIQUE,
  user_code_hash text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending',
  user_id text REFERENCES "user"(id) ON DELETE CASCADE,
  token_id uuid REFERENCES api_tokens(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cli_device_authorizations_status_expires_at_idx ON cli_device_authorizations(status, expires_at);
