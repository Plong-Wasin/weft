ALTER TABLE activities DROP CONSTRAINT IF EXISTS activities_entity_type_check;
ALTER TABLE activities ADD CONSTRAINT activities_entity_type_check
  CHECK (entity_type IN ('work_item', 'state', 'label', 'wiki_page', 'agent', 'runtime', 'trigger', 'skill', 'workspace'));
