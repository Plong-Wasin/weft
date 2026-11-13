-- Usage per Run: whether the CLI or provider reported the token counts. Runs that predate this stay unknown unless they used a server model call.
ALTER TABLE "runs" ADD COLUMN "usage_reported" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "model" text;--> statement-breakpoint
UPDATE "runs" SET "usage_reported" = true WHERE "runtime_id" IS NULL AND ("input_tokens" > 0 OR "output_tokens" > 0);--> statement-breakpoint
-- Admin-edited USD prices per million tokens, one row per model name in a workspace.
CREATE TABLE "model_prices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"model" text NOT NULL,
	"input_usd_per_million" numeric(12, 4) NOT NULL,
	"output_usd_per_million" numeric(12, 4) NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_prices_workspace_id_model_unique" UNIQUE("workspace_id","model")
);--> statement-breakpoint
ALTER TABLE "model_prices" ADD CONSTRAINT "model_prices_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_prices" ADD CONSTRAINT "model_prices_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
