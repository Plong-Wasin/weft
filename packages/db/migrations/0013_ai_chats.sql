CREATE TABLE IF NOT EXISTS ai_chats (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  title text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ai_chats_recents_idx ON ai_chats (user_id, workspace_id, updated_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS ai_messages (
  id text PRIMARY KEY,
  chat_id uuid NOT NULL REFERENCES ai_chats(id) ON DELETE CASCADE,
  seq serial NOT NULL,
  role text NOT NULL,
  parts jsonb NOT NULL,
  input_tokens integer,
  output_tokens integer,
  total_tokens integer,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ai_messages_chat_idx ON ai_messages (chat_id, seq);
