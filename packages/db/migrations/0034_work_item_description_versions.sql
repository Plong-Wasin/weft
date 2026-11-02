CREATE TABLE IF NOT EXISTS "work_item_description_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "work_item_id" uuid NOT NULL REFERENCES "work_items"("id") ON DELETE CASCADE,
  "content" jsonb,
  "content_text" text DEFAULT '' NOT NULL,
  "created_by" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "work_item_description_versions_work_item_id_created_at_idx" ON "work_item_description_versions" ("work_item_id", "created_at");
