ALTER TABLE comments ALTER COLUMN project_id DROP NOT NULL;
ALTER TABLE comments ALTER COLUMN work_item_id DROP NOT NULL;
ALTER TABLE comments ADD COLUMN wiki_page_id uuid REFERENCES wiki_pages(id) ON DELETE CASCADE;
ALTER TABLE comments ADD COLUMN anchor text;
ALTER TABLE comments ADD COLUMN resolved_at timestamp with time zone;
CREATE INDEX comments_wiki_page_id_created_at_idx ON comments (wiki_page_id, created_at);
