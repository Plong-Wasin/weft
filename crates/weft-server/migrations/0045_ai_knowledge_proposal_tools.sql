ALTER TABLE ai_runs DROP CONSTRAINT ai_runs_capability_check;
ALTER TABLE ai_runs ADD CONSTRAINT ai_runs_capability_check
    CHECK (capability IN ('generate','split','link','knowledge'));

ALTER TABLE mcp_tokens DROP CONSTRAINT mcp_tokens_capabilities_check;
ALTER TABLE mcp_tokens ADD CONSTRAINT mcp_tokens_capabilities_check
    CHECK (
        cardinality(capabilities) > 0
        AND capabilities <@ ARRAY['read','generate','split','link','knowledge']::text[]
    );
