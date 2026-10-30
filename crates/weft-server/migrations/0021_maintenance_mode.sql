ALTER TABLE weft_installation
    ADD COLUMN maintenance_mode boolean NOT NULL DEFAULT false,
    ADD COLUMN maintenance_started_at timestamptz;
