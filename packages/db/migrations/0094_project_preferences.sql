-- Per-person sidebar state for projects: star, order (null = never ordered, sorted by name after the ordered ones) and expanded.
CREATE TABLE IF NOT EXISTS project_preferences (
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  starred boolean NOT NULL DEFAULT false,
  position integer,
  expanded boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, project_id)
);

CREATE INDEX IF NOT EXISTS project_preferences_project_id_idx ON project_preferences (project_id);
