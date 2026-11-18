-- A stopped Daemon keeps its Runtimes last-seen time; this flag marks them offline instead. Existing rows stay false: a row already reset to the epoch keeps its unknown offline time.
ALTER TABLE runtimes ADD COLUMN stopped boolean NOT NULL DEFAULT false;
