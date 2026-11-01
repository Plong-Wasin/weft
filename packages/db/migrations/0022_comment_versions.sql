CREATE TABLE IF NOT EXISTS comment_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  comment_id uuid NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  body jsonb NOT NULL,
  body_text text NOT NULL,
  written_at timestamp with time zone NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS comment_versions_comment_id_created_at_idx ON comment_versions (comment_id, created_at);
