-- Ledger groups written when an approved AI Proposal is applied (or undone) name the AI run,
-- provider and Proposal that produced them. The actor stays the approving human.
ALTER TABLE task_operation_groups ADD COLUMN source_run_id uuid;
ALTER TABLE task_operation_groups ADD COLUMN source_proposal_id uuid;
ALTER TABLE task_operation_groups ADD COLUMN source_provider text;

-- One row per approved AI Proposal. It carries no foreign key to runs, Proposals or the ledger,
-- so undoing the data changes (or pruning a run) never removes it. Only the retention window does.
CREATE TABLE ai_approval_audit (
    id uuid PRIMARY KEY,
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    run_id uuid NOT NULL,
    proposal_id uuid NOT NULL UNIQUE,
    proposal_revision integer NOT NULL,
    operation_group_id uuid,
    connection_id uuid,
    provider text NOT NULL,
    capability text NOT NULL,
    initiator_id uuid NOT NULL REFERENCES users(id),
    approved_by uuid NOT NULL REFERENCES users(id),
    run_summary text NOT NULL,
    run_scope jsonb NOT NULL,
    sources jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(sources) = 'array'),
    created_task_count integer NOT NULL DEFAULT 0,
    relation_count integer NOT NULL DEFAULT 0,
    approved_at timestamptz NOT NULL DEFAULT now(),
    undone_at timestamptz,
    undone_by uuid REFERENCES users(id),
    expires_at timestamptz NOT NULL
);

CREATE INDEX ai_approval_audit_by_workspace ON ai_approval_audit(workspace_id, approved_at DESC);
CREATE INDEX ai_approval_audit_expiry ON ai_approval_audit(expires_at);
