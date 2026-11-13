ALTER TABLE api_tokens ADD COLUMN daemon_only boolean NOT NULL DEFAULT false;
UPDATE api_tokens SET daemon_only = true, expires_at = COALESCE(expires_at, now() + interval '30 days')
WHERE id IN (SELECT token_id FROM daemons);
