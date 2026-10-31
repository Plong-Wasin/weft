-- The `plan` capability plans Milestones and sequencing as one Proposal.
ALTER TABLE ai_runs DROP CONSTRAINT ai_runs_capability_check;
ALTER TABLE ai_runs ADD CONSTRAINT ai_runs_capability_check
    CHECK (capability IN ('generate','split','link','knowledge','summarize','review','plan'));

-- Milestone changes a Proposal applied, so Undo can revert them in the same group as Tasks and links.
ALTER TABLE proposal_undo_records ADD COLUMN milestone_changes jsonb NOT NULL DEFAULT '[]'::jsonb;
