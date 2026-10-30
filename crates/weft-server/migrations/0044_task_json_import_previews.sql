CREATE TABLE task_json_import_previews (
    id uuid PRIMARY KEY,
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    actor_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    items jsonb NOT NULL CHECK (jsonb_typeof(items) = 'array'),
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL DEFAULT now() + interval '15 minutes'
);
CREATE INDEX task_json_import_previews_expiry ON task_json_import_previews(expires_at);
