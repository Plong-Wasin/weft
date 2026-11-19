ALTER TABLE cycles ADD COLUMN description_markdown text NOT NULL DEFAULT '';
ALTER TABLE cycles ADD COLUMN description_doc jsonb;
ALTER TABLE modules ADD COLUMN description_markdown text NOT NULL DEFAULT '';
ALTER TABLE modules ADD COLUMN description_doc jsonb;
