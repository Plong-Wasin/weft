ALTER TABLE "workspaces" ADD COLUMN "allow_autopilot" boolean NOT NULL DEFAULT false;
ALTER TABLE activities DROP CONSTRAINT IF EXISTS activities_source_check;
ALTER TABLE activities ADD CONSTRAINT activities_source_check CHECK (source IN ('ui', 'ai', 'ai_autopilot', 'cli', 'mcp', 'agent'));
