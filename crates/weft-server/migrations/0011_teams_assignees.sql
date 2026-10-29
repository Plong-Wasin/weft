CREATE TABLE teams (
    id uuid PRIMARY KEY,
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name text NOT NULL CHECK (length(trim(name)) > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (workspace_id, id),
    UNIQUE (workspace_id, name)
);

CREATE TABLE team_memberships (
    workspace_id uuid NOT NULL,
    team_id uuid NOT NULL,
    user_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (team_id, user_id),
    FOREIGN KEY (workspace_id, team_id) REFERENCES teams(workspace_id, id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, user_id) REFERENCES workspace_memberships(workspace_id, user_id) ON DELETE CASCADE
);

CREATE INDEX team_memberships_by_user ON team_memberships(user_id, team_id);

CREATE TABLE project_team_memberships (
    workspace_id uuid NOT NULL,
    project_id uuid NOT NULL,
    team_id uuid NOT NULL,
    role text NOT NULL CHECK (role IN ('viewer', 'contributor', 'manager')),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, team_id),
    FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, team_id) REFERENCES teams(workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX project_team_memberships_by_team ON project_team_memberships(team_id, project_id);

CREATE TABLE task_assignees (
    workspace_id uuid NOT NULL,
    task_id uuid NOT NULL,
    user_id uuid,
    team_id uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((user_id IS NULL) <> (team_id IS NULL)),
    FOREIGN KEY (workspace_id, task_id) REFERENCES tasks(workspace_id, id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, user_id) REFERENCES workspace_memberships(workspace_id, user_id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, team_id) REFERENCES teams(workspace_id, id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX task_assignees_by_user ON task_assignees(task_id, user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX task_assignees_by_team ON task_assignees(task_id, team_id) WHERE team_id IS NOT NULL;
CREATE INDEX task_assignees_by_team_queue ON task_assignees(team_id, task_id) WHERE team_id IS NOT NULL;
CREATE INDEX task_assignees_by_user_queue ON task_assignees(user_id, task_id) WHERE user_id IS NOT NULL;

CREATE TABLE notification_intents (
    id uuid PRIMARY KEY,
    workspace_id uuid NOT NULL,
    task_id uuid NOT NULL,
    recipient_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    reason text NOT NULL CHECK (reason IN ('assigned', 'mentioned')),
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (workspace_id, task_id) REFERENCES tasks(workspace_id, id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, recipient_id) REFERENCES workspace_memberships(workspace_id, user_id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, actor_id) REFERENCES workspace_memberships(workspace_id, user_id) ON DELETE CASCADE
);

CREATE INDEX notification_intents_by_recipient ON notification_intents(recipient_id, created_at DESC);
