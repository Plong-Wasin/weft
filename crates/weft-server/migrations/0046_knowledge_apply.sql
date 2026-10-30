CREATE TABLE knowledge_apply_groups (
    proposal_id uuid NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
    revision integer NOT NULL,
    vault_id uuid NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
    base_commit text NOT NULL,
    prepared_commit text NOT NULL,
    state text NOT NULL CHECK (state IN ('prepared','applying','applied','needs_attention','undoing','undone')),
    error text,
    undo_base_commit text,
    undo_commit text,
    PRIMARY KEY (proposal_id, revision, vault_id)
);

ALTER TABLE proposal_undo_records ADD COLUMN knowledge_items jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE proposals DROP CONSTRAINT proposals_status_check;
ALTER TABLE proposals ADD CONSTRAINT proposals_status_check
    CHECK (status IN ('pending','ready','applying','needs_attention','applied','undone'));
