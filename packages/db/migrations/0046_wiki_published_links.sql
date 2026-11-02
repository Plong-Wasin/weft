ALTER TABLE "wiki_pages" ADD COLUMN "published_token_hash" text;
CREATE UNIQUE INDEX "wiki_pages_published_token_hash_idx" ON "wiki_pages" ("published_token_hash");
