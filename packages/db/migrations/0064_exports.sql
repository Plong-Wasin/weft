-- An Export is a file of a member's work items, built in the background. The row is owned by one member.
-- Rollback: DROP TABLE IF EXISTS exports;
CREATE TABLE exports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  project_ids jsonb NOT NULL,
  format text NOT NULL CHECK (format IN ('csv', 'json')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'completed', 'failed')),
  failure_reason text,
  file_key text,
  file_size bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
--> statement-breakpoint
CREATE INDEX exports_owner_idx ON exports (workspace_id, owner_id, created_at DESC);
