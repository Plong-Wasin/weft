-- A live save whose Written form hit a conversion limit keeps the editor document and flags the stored Markdown as stale.
ALTER TABLE wiki_pages ADD COLUMN markdown_stale boolean NOT NULL DEFAULT false;
