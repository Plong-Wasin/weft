CREATE TABLE IF NOT EXISTS "work_item_relations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "work_item_id" uuid NOT NULL REFERENCES "work_items"("id") ON DELETE CASCADE,
  "related_work_item_id" uuid NOT NULL REFERENCES "work_items"("id") ON DELETE CASCADE,
  "type" text NOT NULL,
  "created_by" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "work_item_relations_type_check" CHECK ("type" IN ('blocked_by', 'duplicate', 'relates_to')),
  CONSTRAINT "work_item_relations_no_self_check" CHECK ("work_item_id" <> "related_work_item_id")
);
CREATE INDEX IF NOT EXISTS "work_item_relations_work_item_id_index" ON "work_item_relations" ("work_item_id");
CREATE INDEX IF NOT EXISTS "work_item_relations_related_work_item_id_index" ON "work_item_relations" ("related_work_item_id");
CREATE UNIQUE INDEX IF NOT EXISTS "work_item_relations_pair_unique" ON "work_item_relations" (LEAST("work_item_id", "related_work_item_id"), GREATEST("work_item_id", "related_work_item_id"));
