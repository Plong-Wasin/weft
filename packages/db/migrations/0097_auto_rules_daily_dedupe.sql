-- Daily auto-rules keys remain reserved after a job finishes, preventing a second scheduler from rerunning the same day.
CREATE UNIQUE INDEX IF NOT EXISTS jobs_auto_rules_day_dedupe_idx
  ON jobs (dedupe_key)
  WHERE type = 'auto_rules' AND dedupe_key LIKE 'auto_rules:%';
