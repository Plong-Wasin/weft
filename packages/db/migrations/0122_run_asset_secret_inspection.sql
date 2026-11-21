ALTER TABLE runs ADD COLUMN runtime_environment_secrets text;
ALTER TABLE assets ADD COLUMN unverified boolean NOT NULL DEFAULT false;
