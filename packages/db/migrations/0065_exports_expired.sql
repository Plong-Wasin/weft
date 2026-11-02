-- The cleanup job deletes an Export's stored file after 7 days and marks the row expired; the row stays in the list.
-- Rollback: ALTER TABLE exports DROP COLUMN IF EXISTS expired_at;
ALTER TABLE exports ADD COLUMN expired_at timestamptz;
