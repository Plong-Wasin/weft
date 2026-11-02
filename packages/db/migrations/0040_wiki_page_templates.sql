CREATE TABLE wiki_page_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_by text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  title text NOT NULL,
  content jsonb,
  content_text text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX wiki_page_templates_workspace_created_idx ON wiki_page_templates(workspace_id, created_at);
