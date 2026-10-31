-- Workspace-scoped Task and Project templates. A template is a recipe and never carries access: no
-- members, no Teams, no visibility. References to Statuses, Attributes and Task templates live in
-- JSON so that an archived or deleted target is reported at use time instead of blocking the archive.
CREATE TABLE task_templates (
    id uuid PRIMARY KEY,
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name text NOT NULL CHECK (length(trim(name)) > 0),
    title_pattern text NOT NULL CHECK (length(trim(title_pattern)) > 0),
    description text NOT NULL DEFAULT '',
    priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
    default_status text,
    checklist jsonb NOT NULL DEFAULT '[]',
    subtasks jsonb NOT NULL DEFAULT '[]',
    attributes jsonb NOT NULL DEFAULT '[]',
    version bigint NOT NULL DEFAULT 1,
    created_by uuid NOT NULL REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (workspace_id, id)
);

CREATE TABLE project_templates (
    id uuid PRIMARY KEY,
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name text NOT NULL CHECK (length(trim(name)) > 0),
    description text NOT NULL DEFAULT '',
    statuses jsonb NOT NULL DEFAULT '[]',
    milestones jsonb NOT NULL DEFAULT '[]',
    task_templates jsonb NOT NULL DEFAULT '[]',
    version bigint NOT NULL DEFAULT 1,
    created_by uuid NOT NULL REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (workspace_id, id)
);

CREATE INDEX task_templates_by_workspace ON task_templates (workspace_id, name);
CREATE INDEX project_templates_by_workspace ON project_templates (workspace_id, name);

-- A Project created from a template is part of the same operation group as its Tasks: Undo of the
-- group archives the Project too, Redo restores it.
CREATE TABLE template_created_projects (
    group_id uuid PRIMARY KEY REFERENCES task_operation_groups(id) ON DELETE CASCADE,
    workspace_id uuid NOT NULL,
    project_id uuid NOT NULL,
    FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id)
);
