-- The outbox is pruned after a retention window (see realtime.rs). The floor remembers, per
-- Workspace, the highest pruned id: a client cursor below it may have missed events and has to
-- take a new snapshot instead of resuming.
CREATE INDEX realtime_outbox_created_at ON realtime_outbox(created_at);
CREATE TABLE realtime_outbox_floor (
    workspace_id uuid PRIMARY KEY,
    pruned_through bigint NOT NULL
);
