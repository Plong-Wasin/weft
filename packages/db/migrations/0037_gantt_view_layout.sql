ALTER TABLE views DROP CONSTRAINT IF EXISTS views_layout_check;
--> statement-breakpoint
ALTER TABLE views ADD CONSTRAINT views_layout_check CHECK (layout IN ('list', 'board', 'spreadsheet', 'calendar', 'gantt'));
