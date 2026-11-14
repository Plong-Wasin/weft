-- A suspended member keeps the membership row, so reactivation restores roles and project access.
ALTER TABLE workspace_members ADD COLUMN suspended_at timestamp with time zone;
-- Set by a workspace Admin's forced reset: the person must choose a new password before any Action.
ALTER TABLE "user" ADD COLUMN force_password_reset boolean NOT NULL DEFAULT false;
-- A plain-language reason shown once at the next sign-in, then cleared by the person.
ALTER TABLE "user" ADD COLUMN security_notice text;
ALTER TABLE activities DROP CONSTRAINT IF EXISTS activities_entity_type_check;
ALTER TABLE activities ADD CONSTRAINT activities_entity_type_check
  CHECK (entity_type IN ('work_item', 'state', 'label', 'wiki_page', 'agent', 'runtime', 'trigger', 'skill', 'workspace', 'member', 'api_token'));
