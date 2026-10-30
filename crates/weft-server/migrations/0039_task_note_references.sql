CREATE TABLE vault_note_identities (
    id uuid PRIMARY KEY,
    vault_id uuid NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
    path text NOT NULL,
    deleted_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX vault_note_identities_active_path
    ON vault_note_identities(vault_id, path) WHERE deleted_at IS NULL;

INSERT INTO vault_note_identities(id, vault_id, path)
SELECT gen_random_uuid(), vault_id, path FROM vault_indexed_files;

CREATE TABLE task_note_references (
    workspace_id uuid NOT NULL,
    note_id uuid NOT NULL REFERENCES vault_note_identities(id),
    source_kind text NOT NULL CHECK (source_kind IN ('task_description', 'comment')),
    source_task_id uuid NOT NULL,
    source_comment_id uuid,
    position integer NOT NULL CHECK (position >= 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((source_kind = 'comment') = (source_comment_id IS NOT NULL)),
    FOREIGN KEY (workspace_id, source_task_id) REFERENCES tasks(workspace_id, id) ON DELETE CASCADE,
    FOREIGN KEY (source_comment_id) REFERENCES task_comments(id) ON DELETE CASCADE,
    UNIQUE (source_kind, source_task_id, source_comment_id, position)
);

CREATE INDEX task_note_references_by_note ON task_note_references(note_id, source_kind, source_task_id);
