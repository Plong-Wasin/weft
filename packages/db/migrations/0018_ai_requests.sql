CREATE TABLE IF NOT EXISTS "ai_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "ai_requests_user_id_created_at_index" ON "ai_requests" ("user_id", "created_at");
