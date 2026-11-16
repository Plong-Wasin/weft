-- The Can wake Agents switch (ADR 0013): an Agent's assignments, mentions and changes wake other Agents only when it is on. Off for every existing Agent.
ALTER TABLE agents ADD COLUMN can_wake_agents boolean NOT NULL DEFAULT false;
