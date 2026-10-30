-- The `progress_review` capability reports delivery risks and may propose Milestone updates,
-- subtasks and links through the existing Proposal engine.
ALTER TABLE ai_runs DROP CONSTRAINT ai_runs_capability_check;
ALTER TABLE ai_runs ADD CONSTRAINT ai_runs_capability_check
    CHECK (capability IN ('generate','split','link','knowledge','summarize','review','plan','progress_review'));
