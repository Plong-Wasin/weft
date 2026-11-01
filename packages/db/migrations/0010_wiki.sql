CREATE TABLE IF NOT EXISTS "wiki_pages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "parent_id" uuid REFERENCES "wiki_pages"("id") ON DELETE SET NULL,
  "owner_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "title" text NOT NULL,
  "content" jsonb,
  "content_text" text DEFAULT '' NOT NULL,
  "access" text DEFAULT 'public' NOT NULL,
  "sort_order" double precision DEFAULT 0 NOT NULL,
  "locked_by" text REFERENCES "user"("id") ON DELETE SET NULL,
  "lock_expires_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wiki_pages_workspace_parent_idx" ON "wiki_pages" ("workspace_id", "parent_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "wiki_page_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "page_id" uuid NOT NULL REFERENCES "wiki_pages"("id") ON DELETE CASCADE,
  "title" text NOT NULL,
  "content" jsonb,
  "content_text" text DEFAULT '' NOT NULL,
  "created_by" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wiki_page_versions_page_created_idx" ON "wiki_page_versions" ("page_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS wiki_pages_title_trgm_idx ON wiki_pages USING gin (title gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS wiki_pages_content_text_trgm_idx ON wiki_pages USING gin (content_text gin_trgm_ops);
