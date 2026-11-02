ALTER TABLE wiki_pages ADD COLUMN ydoc_state bytea;
ALTER TABLE wiki_page_versions ADD COLUMN ydoc_state bytea;
ALTER TABLE wiki_pages DROP COLUMN locked_by;
ALTER TABLE wiki_pages DROP COLUMN lock_expires_at;
