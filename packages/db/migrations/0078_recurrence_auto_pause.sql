ALTER TABLE recurrences ADD COLUMN paused_reason text;
ALTER TABLE recurrences ADD COLUMN paused_at timestamptz;
ALTER TABLE notifications ADD COLUMN recurrence_id uuid;
ALTER TABLE notifications ADD COLUMN detail text;
