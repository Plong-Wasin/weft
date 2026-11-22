ALTER TABLE notifications ADD COLUMN run_id uuid REFERENCES runs(id) ON DELETE CASCADE;
