CREATE TABLE "wiki_page_shares" (
  "page_id" uuid NOT NULL REFERENCES "wiki_pages"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "role" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("page_id", "user_id")
);
CREATE INDEX "wiki_page_shares_user_id_idx" ON "wiki_page_shares" ("user_id");
