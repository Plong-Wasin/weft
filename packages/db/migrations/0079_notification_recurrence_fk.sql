DELETE FROM notifications WHERE recurrence_id IS NOT NULL AND recurrence_id NOT IN (SELECT id FROM recurrences);
ALTER TABLE notifications ADD CONSTRAINT notifications_recurrence_id_fkey FOREIGN KEY (recurrence_id) REFERENCES recurrences(id) ON DELETE CASCADE;
