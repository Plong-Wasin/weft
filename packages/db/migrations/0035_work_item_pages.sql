CREATE TABLE work_item_pages (
  work_item_id uuid NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  page_id uuid NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
  created_by text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (work_item_id, page_id)
);
CREATE INDEX work_item_pages_page_idx ON work_item_pages (page_id);
