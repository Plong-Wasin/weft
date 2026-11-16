-- Outlinks are kept per part of a source (its body, each comment, legacy page links), so a write replaces only its own part and never parses another row.
ALTER TABLE outlinks ADD COLUMN source_part text NOT NULL DEFAULT 'body';
ALTER TABLE outlinks DROP CONSTRAINT outlinks_pkey;
ALTER TABLE outlinks ADD PRIMARY KEY (source_kind, source_id, source_part, target_kind, target_id);
-- The Work item's description document is a derived cache written with the Markdown in the same statement; the Markdown stays the original.
ALTER TABLE work_items ADD COLUMN description_doc jsonb;
