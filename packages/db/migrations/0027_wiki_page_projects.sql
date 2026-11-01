CREATE TABLE IF NOT EXISTS wiki_page_projects (
  page_id uuid NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  linked_by text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (page_id, project_id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS wiki_page_projects_project_idx ON wiki_page_projects (project_id);
