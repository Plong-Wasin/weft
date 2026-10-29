CREATE TABLE vaults (
    id uuid PRIMARY KEY,
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name text NOT NULL CHECK (length(trim(name)) > 0),
    visibility text NOT NULL DEFAULT 'restricted' CHECK (visibility IN ('restricted', 'workspace')),
    repository_path text NOT NULL UNIQUE,
    created_by uuid NOT NULL REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (workspace_id, id),
    UNIQUE (workspace_id, name)
);

CREATE TABLE vault_user_memberships (
    workspace_id uuid NOT NULL,
    vault_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role text NOT NULL CHECK (role IN ('viewer', 'contributor', 'manager')),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (vault_id, user_id),
    FOREIGN KEY (workspace_id, vault_id) REFERENCES vaults(workspace_id, id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, user_id) REFERENCES workspace_memberships(workspace_id, user_id) ON DELETE CASCADE
);

CREATE TABLE vault_team_memberships (
    workspace_id uuid NOT NULL,
    vault_id uuid NOT NULL,
    team_id uuid NOT NULL,
    role text NOT NULL CHECK (role IN ('viewer', 'contributor', 'manager')),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (vault_id, team_id),
    FOREIGN KEY (workspace_id, vault_id) REFERENCES vaults(workspace_id, id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, team_id) REFERENCES teams(workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE vault_project_memberships (
    workspace_id uuid NOT NULL,
    vault_id uuid NOT NULL,
    project_id uuid NOT NULL,
    role text NOT NULL CHECK (role IN ('viewer', 'contributor', 'manager')),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (vault_id, project_id),
    FOREIGN KEY (workspace_id, vault_id) REFERENCES vaults(workspace_id, id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX vault_user_memberships_by_user ON vault_user_memberships(user_id, vault_id);
CREATE INDEX vault_team_memberships_by_team ON vault_team_memberships(team_id, vault_id);
CREATE INDEX vault_project_memberships_by_project ON vault_project_memberships(project_id, vault_id);
CREATE INDEX vaults_by_workspace ON vaults(workspace_id, name);
