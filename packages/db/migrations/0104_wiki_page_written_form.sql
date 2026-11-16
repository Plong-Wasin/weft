ALTER TABLE wiki_pages ADD COLUMN content_markdown text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE wiki_page_versions ADD COLUMN content_markdown text NOT NULL DEFAULT '';
