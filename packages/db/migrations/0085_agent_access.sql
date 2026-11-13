CREATE TABLE "agent_access" (
  "agent_id" uuid NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  PRIMARY KEY ("agent_id", "user_id")
);
INSERT INTO "agent_access" ("agent_id", "user_id")
SELECT a.id, r.owner_id FROM agents a JOIN runtimes r ON r.id = a.runtime_id
ON CONFLICT DO NOTHING;
INSERT INTO "agent_access" ("agent_id", "user_id")
SELECT DISTINCT a.id, pm.user_id FROM agents a JOIN agent_projects ap ON ap.agent_id = a.id JOIN project_members pm ON pm.project_id = ap.project_id JOIN "user" u ON u.id = pm.user_id WHERE a.runtime_id IS NULL AND u.is_agent = false
ON CONFLICT DO NOTHING;
INSERT INTO "agent_access" ("agent_id", "user_id")
SELECT DISTINCT a.id, pm.user_id FROM agents a JOIN projects p ON p.workspace_id = a.workspace_id JOIN project_members pm ON pm.project_id = p.id JOIN "user" u ON u.id = pm.user_id WHERE a.runtime_id IS NULL AND a.all_projects = true AND u.is_agent = false
ON CONFLICT DO NOTHING;
