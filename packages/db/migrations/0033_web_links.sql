CREATE TABLE web_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  work_item_id uuid NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  url text NOT NULL,
  title text,
  created_by text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT web_links_http_url CHECK (url ~* '^https?://')
);
--> statement-breakpoint
CREATE INDEX web_links_work_item_id_idx ON web_links(work_item_id);
