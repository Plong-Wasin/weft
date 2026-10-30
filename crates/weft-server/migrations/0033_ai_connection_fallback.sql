ALTER TABLE ai_connections ADD COLUMN fallback_connection_id uuid REFERENCES ai_connections(id) ON DELETE SET NULL;
ALTER TABLE ai_connections ADD CONSTRAINT ai_connections_fallback_not_self CHECK (fallback_connection_id IS NULL OR fallback_connection_id <> id);
ALTER TABLE ai_runs ADD COLUMN fallback_from uuid REFERENCES ai_connections(id) ON DELETE SET NULL;
