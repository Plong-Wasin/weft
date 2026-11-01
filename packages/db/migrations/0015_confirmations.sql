CREATE TABLE IF NOT EXISTS confirmations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  chat_id uuid NOT NULL REFERENCES ai_chats(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  action text NOT NULL,
  input jsonb NOT NULL,
  snapshot jsonb,
  status text NOT NULL DEFAULT 'pending',
  result jsonb,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS confirmations_chat_idx ON confirmations (chat_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS confirmations_expires_idx ON confirmations (expires_at);
