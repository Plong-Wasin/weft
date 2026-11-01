CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS work_items_title_trgm_idx ON work_items USING gin (title gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS work_items_description_text_trgm_idx ON work_items USING gin (description_text gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS work_items_fts_idx ON work_items USING gin (to_tsvector('english', title || ' ' || description_text));
