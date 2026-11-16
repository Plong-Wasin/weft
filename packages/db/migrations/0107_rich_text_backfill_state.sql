CREATE TABLE rich_text_backfill_state (
  key text PRIMARY KEY,
  completed_at timestamptz NOT NULL DEFAULT now()
);
