ALTER TABLE agents
  ADD COLUMN allow_project_actions boolean NOT NULL DEFAULT false,
  ADD COLUMN allow_member_actions boolean NOT NULL DEFAULT false,
  ADD COLUMN allow_feature_actions boolean NOT NULL DEFAULT false,
  ADD COLUMN allow_export_actions boolean NOT NULL DEFAULT false;
ALTER TABLE activities DROP CONSTRAINT IF EXISTS activities_entity_type_check;
ALTER TABLE activities ADD CONSTRAINT activities_entity_type_check CHECK (entity_type IN ('work_item', 'state', 'label', 'wiki_page', 'agent'));
