-- A Project carries a delivery state and calendar target dates (no time zone). They describe the
-- plan only; they never move a Task and never grant access.
ALTER TABLE projects
    ADD COLUMN state text NOT NULL DEFAULT 'active' CHECK (state IN ('planned','active','completed','canceled')),
    ADD COLUMN target_start_date date,
    ADD COLUMN target_end_date date,
    ADD CONSTRAINT projects_target_dates_ordered CHECK (target_start_date IS NULL OR target_end_date IS NULL OR target_start_date <= target_end_date);
