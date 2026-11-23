ALTER TABLE api_tokens ADD COLUMN cli_device_id uuid;
ALTER TABLE daemons ADD COLUMN cli_device_id uuid;

CREATE INDEX api_tokens_cli_device_id_idx ON api_tokens (user_id, cli_device_id);
CREATE UNIQUE INDEX daemons_owner_cli_device_unique_idx ON daemons (owner_id, cli_device_id) WHERE cli_device_id IS NOT NULL;

ALTER TABLE activities DROP CONSTRAINT IF EXISTS activities_entity_type_check;
ALTER TABLE activities ADD CONSTRAINT activities_entity_type_check CHECK (entity_type IN ('work_item', 'state', 'label', 'wiki_page', 'agent', 'runtime', 'trigger', 'skill', 'workspace', 'member', 'api_token', 'cli_device'));
