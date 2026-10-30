ALTER TABLE vault_indexed_files
    ADD COLUMN title text NOT NULL DEFAULT '',
    ADD COLUMN search_text text NOT NULL DEFAULT '',
    ADD COLUMN properties jsonb NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN tags text[] NOT NULL DEFAULT '{}',
    ADD COLUMN outgoing_links text[] NOT NULL DEFAULT '{}',
    ADD COLUMN parser_version text NOT NULL DEFAULT '';

CREATE INDEX vault_indexed_files_search_trgm
    ON vault_indexed_files USING GIN (search_text public.gin_trgm_ops);

CREATE TABLE vault_search_states (
    vault_id uuid PRIMARY KEY REFERENCES vaults(id) ON DELETE CASCADE,
    status text NOT NULL CHECK (status IN ('queued', 'running', 'ready', 'failed')),
    parser_version text,
    updated_at timestamptz NOT NULL DEFAULT now()
);
