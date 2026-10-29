-- Groups written by system-wide Status changes: shown in Task history, never an undo target.
ALTER TABLE task_operation_groups DROP CONSTRAINT task_operation_groups_state_check;
ALTER TABLE task_operation_groups ADD CONSTRAINT task_operation_groups_state_check
    CHECK (state IN ('active','undone','suppressed','recorded'));
