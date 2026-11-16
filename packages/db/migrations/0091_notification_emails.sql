-- Email notifications: each person picks the kinds they get by email (empty = none).
ALTER TABLE "user" ADD COLUMN "email_notification_kinds" text[] DEFAULT ARRAY['assignment','mention','reply','run_result']::text[] NOT NULL;--> statement-breakpoint
-- Notifications wait here until the next digest sends them; the digest job sets sent_at.
CREATE TABLE "notification_emails" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"kind" text NOT NULL,
	"work_item_id" uuid,
	"wiki_page_id" uuid,
	"comment_id" uuid,
	"detail" text,
	"job_id" uuid,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_emails_job_id_user_id_unique" UNIQUE("job_id","user_id")
);--> statement-breakpoint
ALTER TABLE "notification_emails" ADD CONSTRAINT "notification_emails_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_emails" ADD CONSTRAINT "notification_emails_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_emails" ADD CONSTRAINT "notification_emails_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_emails" ADD CONSTRAINT "notification_emails_work_item_id_work_items_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "public"."work_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_emails" ADD CONSTRAINT "notification_emails_wiki_page_id_wiki_pages_id_fk" FOREIGN KEY ("wiki_page_id") REFERENCES "public"."wiki_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_emails" ADD CONSTRAINT "notification_emails_comment_id_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notification_emails_user_id_sent_at_created_at_index" ON "notification_emails" USING btree ("user_id","sent_at","created_at");--> statement-breakpoint
CREATE INDEX "notification_emails_created_at_index" ON "notification_emails" USING btree ("created_at");
