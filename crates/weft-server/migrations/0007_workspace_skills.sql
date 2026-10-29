CREATE TABLE workspace_skill_settings (
    workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
    max_name_chars integer NOT NULL DEFAULT 120 CHECK (max_name_chars BETWEEN 1 AND 1000),
    max_description_chars integer NOT NULL DEFAULT 300 CHECK (max_description_chars BETWEEN 1 AND 10000),
    max_body_chars integer NOT NULL DEFAULT 16000 CHECK (max_body_chars BETWEEN 1 AND 1000000)
);

CREATE TABLE skills (
    id uuid PRIMARY KEY,
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name text NOT NULL,
    description text NOT NULL,
    body text NOT NULL,
    enabled boolean NOT NULL DEFAULT true,
    archived_at timestamptz,
    version bigint NOT NULL DEFAULT 1,
    created_by uuid NOT NULL REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (workspace_id, name)
);
CREATE INDEX skills_enabled_by_workspace ON skills(workspace_id, name) WHERE enabled AND archived_at IS NULL;

CREATE TABLE skill_operations (
    id uuid PRIMARY KEY,
    group_id uuid NOT NULL REFERENCES task_operation_groups(id) ON DELETE CASCADE,
    skill_id uuid NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
    field_key text NOT NULL,
    before_value jsonb NOT NULL,
    after_value jsonb NOT NULL,
    skill_version bigint NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    suppressed boolean NOT NULL DEFAULT false,
    UNIQUE (group_id, skill_id, field_key)
);
CREATE INDEX skill_operations_by_skill ON skill_operations(skill_id,created_at);

CREATE FUNCTION seed_default_workspace_skill() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO workspace_skill_settings(workspace_id) VALUES (NEW.workspace_id) ON CONFLICT DO NOTHING;
    INSERT INTO skills(id,workspace_id,name,description,body,created_by)
    VALUES (gen_random_uuid(),NEW.workspace_id,'How this Workspace works',
        'Learn the Workspace workflow, tasks, people and teams.',
        E'Weft is a shared work management system. Use the available tools to learn about the Workspace before acting.\n\nTasks have stable numbers such as #123. A Task has a title, description, Status, Priority, Assignees, dates and Watchers. Reference a task as #123; its content is not expanded automatically.\n\nAn Assignee can be a person or a Team. Teams represent people who work together. Use list_teams to see the available Teams and list_attributes to inspect task fields.\n\nChanges are prepared as Proposals. A person reviews and approves each Proposal; do not claim that a change has happened until it is approved. Skills provide context only and never grant permissions.',
        NEW.user_id)
    ON CONFLICT (workspace_id,name) DO NOTHING;
    RETURN NEW;
END $$;

CREATE FUNCTION initialize_workspace_skill_settings() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO workspace_skill_settings(workspace_id) VALUES (NEW.id);
    RETURN NEW;
END $$;
CREATE TRIGGER workspaces_skill_settings
AFTER INSERT ON workspaces
FOR EACH ROW EXECUTE FUNCTION initialize_workspace_skill_settings();

CREATE TRIGGER owner_seeds_default_workspace_skill
AFTER INSERT ON workspace_memberships
FOR EACH ROW WHEN (NEW.role='owner')
EXECUTE FUNCTION seed_default_workspace_skill();
