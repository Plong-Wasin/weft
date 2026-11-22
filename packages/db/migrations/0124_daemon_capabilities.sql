ALTER TABLE daemons ADD COLUMN capabilities jsonb NOT NULL DEFAULT '[]'::jsonb;
