ALTER TABLE notifications ALTER COLUMN work_item_id DROP NOT NULL;
ALTER TABLE notifications ADD COLUMN wiki_page_id uuid REFERENCES wiki_pages(id) ON DELETE CASCADE;
