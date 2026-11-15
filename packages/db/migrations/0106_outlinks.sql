CREATE TABLE outlinks (
  source_kind text NOT NULL CHECK (source_kind IN ('work-item', 'page', 'wiki')),
  source_id uuid NOT NULL,
  target_kind text NOT NULL CHECK (target_kind IN ('work-item', 'page', 'wiki')),
  target_id uuid NOT NULL,
  PRIMARY KEY (source_kind, source_id, target_kind, target_id)
);
CREATE INDEX outlinks_target_idx ON outlinks (target_kind, target_id);

INSERT INTO outlinks (source_kind, source_id, target_kind, target_id)
SELECT 'work-item', work_item_pages.work_item_id,
  CASE WHEN wiki_pages.project_id IS NULL THEN 'wiki' ELSE 'page' END,
  wiki_pages.id
FROM work_item_pages
JOIN wiki_pages ON wiki_pages.id = work_item_pages.page_id;
