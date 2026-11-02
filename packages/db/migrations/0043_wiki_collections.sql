CREATE TABLE wiki_collections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  name text NOT NULL,
  icon text NOT NULL DEFAULT '📚',
  visibility text NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'private')),
  is_default boolean NOT NULL DEFAULT false,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX wiki_collections_workspace_deleted_idx ON wiki_collections(workspace_id, deleted_at);
CREATE UNIQUE INDEX wiki_collections_one_default_idx ON wiki_collections(workspace_id) WHERE is_default;
CREATE TABLE wiki_collection_members (
  collection_id uuid NOT NULL REFERENCES wiki_collections(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (collection_id, user_id)
);
ALTER TABLE wiki_pages ADD COLUMN collection_id uuid REFERENCES wiki_collections(id) ON DELETE SET NULL;
INSERT INTO wiki_collections(workspace_id, owner_id, name, is_default)
SELECT w.id, wm.user_id, 'Wiki', true
FROM workspaces w
JOIN LATERAL (SELECT user_id FROM workspace_members WHERE workspace_id = w.id ORDER BY created_at LIMIT 1) wm ON true;
UPDATE wiki_pages p SET collection_id = c.id FROM wiki_collections c
WHERE c.workspace_id = p.workspace_id AND c.is_default AND p.project_id IS NULL;
CREATE INDEX wiki_pages_collection_idx ON wiki_pages(collection_id);
