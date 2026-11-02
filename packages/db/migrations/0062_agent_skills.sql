CREATE TABLE agent_skills (
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  skill_id uuid NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  PRIMARY KEY (agent_id, skill_id)
);
--> statement-breakpoint
CREATE INDEX agent_skills_skill_id_idx ON agent_skills (skill_id);
