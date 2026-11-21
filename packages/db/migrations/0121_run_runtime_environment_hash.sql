-- A provider account change must not resume the prior CLI conversation.
ALTER TABLE runs ADD COLUMN runtime_environment_hash text;
