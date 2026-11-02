ALTER TABLE wiki_pages
  ADD COLUMN IF NOT EXISTS project_id uuid REFERENCES projects(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS wiki_pages_project_id_idx ON wiki_pages (project_id);
DROP TABLE IF EXISTS wiki_page_projects;
