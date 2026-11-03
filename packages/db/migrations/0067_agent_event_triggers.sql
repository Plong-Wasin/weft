CREATE TABLE "triggers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
	"project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
	"creator_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
	"event_type" text NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX "triggers_agent_project_idx" ON "triggers" USING btree ("agent_id", "project_id");
