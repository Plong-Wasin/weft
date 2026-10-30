ALTER TABLE proposals ADD COLUMN remaining_in_original jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(remaining_in_original)='array');
