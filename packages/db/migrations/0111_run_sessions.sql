-- A Run on a Runtime resumes the CLI Session of the previous Run of the same Agent, work item and Runtime, in a stable folder (ADR 0014).
-- Nullable or defaulted, so existing rows stay valid: a Run without these values starts a new Session.
ALTER TABLE runs ADD COLUMN cli_session_id text;
ALTER TABLE runs ADD COLUMN session_folder text;
ALTER TABLE runs ADD COLUMN session_mode text;
ALTER TABLE runs ADD COLUMN session_reason text;
ALTER TABLE runs ADD COLUMN fresh_session boolean NOT NULL DEFAULT false;
CREATE INDEX runs_session_folder_idx ON runs (session_folder);
