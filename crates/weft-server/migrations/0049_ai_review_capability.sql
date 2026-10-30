ALTER TABLE ai_runs DROP CONSTRAINT ai_runs_capability_check;
ALTER TABLE ai_runs ADD CONSTRAINT ai_runs_capability_check
    CHECK (capability IN ('generate','split','link','knowledge','summarize','review'));
