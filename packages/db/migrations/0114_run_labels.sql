-- A Run keeps the name of its Agent and the label of its Runtime ("host · agent CLI") from the moment it is created, so history reads after either is deleted. Not backfilled: older Runs stay empty.
ALTER TABLE runs ADD COLUMN agent_name text;
ALTER TABLE runs ADD COLUMN runtime_label text;
