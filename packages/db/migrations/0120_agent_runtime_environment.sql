-- Runtime owner controlled per-Agent variables are encrypted before reaching this column.
ALTER TABLE agents ADD COLUMN runtime_environment text;
