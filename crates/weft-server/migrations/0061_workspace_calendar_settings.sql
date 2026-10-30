-- Calendar and date views read "today" and the first day of the week from the Workspace.
ALTER TABLE workspaces
    ADD COLUMN IF NOT EXISTS week_start smallint NOT NULL DEFAULT 1 CHECK (week_start BETWEEN 0 AND 6),
    ADD COLUMN IF NOT EXISTS time_zone text NOT NULL DEFAULT 'UTC';
