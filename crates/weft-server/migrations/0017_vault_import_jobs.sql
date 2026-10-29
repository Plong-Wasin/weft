CREATE TABLE vault_import_jobs (
    id uuid PRIMARY KEY,
    workspace_id uuid NOT NULL,
    vault_id uuid NOT NULL,
    actor_id uuid NOT NULL REFERENCES users(id),
    source text NOT NULL CHECK (source IN ('repository', 'archive')),
    status text NOT NULL CHECK (status IN ('queued', 'importing', 'reindexing', 'completed', 'failed')),
    reindex_status text NOT NULL CHECK (reindex_status IN ('queued', 'running', 'completed', 'failed')),
    error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (vault_id),
    FOREIGN KEY (workspace_id, vault_id) REFERENCES vaults(workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX vault_import_jobs_by_vault ON vault_import_jobs(vault_id, created_at DESC);

CREATE TABLE vault_indexed_files (
    vault_id uuid NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
    path text NOT NULL,
    text_content text,
    indexed_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (vault_id, path)
);
