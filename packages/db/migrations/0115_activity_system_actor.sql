-- The hourly cleanup of stale Runtimes changes Runtimes with no person as actor: its activity rows have no actor and source system.
ALTER TABLE "activities" ALTER COLUMN "actor_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE activities DROP CONSTRAINT IF EXISTS activities_source_check;
--> statement-breakpoint
ALTER TABLE activities ADD CONSTRAINT activities_source_check CHECK (source IN ('ui', 'ai', 'ai_autopilot', 'cli', 'mcp', 'agent', 'agent_autopilot', 'integration', 'auto_rule', 'system'));
