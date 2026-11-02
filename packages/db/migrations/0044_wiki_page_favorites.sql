CREATE TABLE IF NOT EXISTS wiki_page_favorites (
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  page_id uuid NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, page_id)
);

CREATE INDEX IF NOT EXISTS wiki_page_favorites_page_id_idx ON wiki_page_favorites (page_id);
