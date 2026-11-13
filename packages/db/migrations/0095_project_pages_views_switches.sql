-- Pages and Views switches for projects. Existing projects get true, so they keep every feature they have today; the Simple shape for new projects is set by the create action, not by this default.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS pages_enabled boolean NOT NULL DEFAULT true;
--> statement-breakpoint
ALTER TABLE projects ADD COLUMN IF NOT EXISTS views_enabled boolean NOT NULL DEFAULT true;
