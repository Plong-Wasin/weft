CREATE INDEX IF NOT EXISTS wiki_pages_fts_idx
  ON wiki_pages USING gin (to_tsvector('english', title || ' ' || content_text));
