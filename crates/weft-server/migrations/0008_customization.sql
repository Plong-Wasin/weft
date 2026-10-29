ALTER TABLE tasks DROP CONSTRAINT tasks_status_check;
ALTER TABLE tasks ADD COLUMN completed_at timestamptz;

CREATE TABLE workspace_statuses (
    id uuid PRIMARY KEY,
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    status_key text NOT NULL,
    name text NOT NULL CHECK (length(trim(name)) > 0),
    category text NOT NULL CHECK (category IN ('not_started','active','completed','canceled')),
    color text NOT NULL DEFAULT '#64748b',
    position integer NOT NULL,
    archived_at timestamptz,
    UNIQUE (workspace_id, id),
    UNIQUE (workspace_id, status_key)
);

INSERT INTO workspace_statuses(id,workspace_id,status_key,name,category,color,position)
SELECT gen_random_uuid(),w.id,v.status_key,v.name,v.category,v.color,v.position
FROM workspaces w
CROSS JOIN (VALUES
    ('backlog','Backlog','not_started','#64748b',0),
    ('not_started','Not started','not_started','#64748b',1),
    ('active','In progress','active','#3b82f6',2),
    ('completed','Completed','completed','#22c55e',3),
    ('canceled','Canceled','canceled','#ef4444',4)
) AS v(status_key,name,category,color,position);

CREATE FUNCTION seed_workspace_statuses() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO workspace_statuses(id,workspace_id,status_key,name,category,color,position)
    VALUES
        (gen_random_uuid(),NEW.id,'backlog','Backlog','not_started','#64748b',0),
        (gen_random_uuid(),NEW.id,'not_started','Not started','not_started','#64748b',1),
        (gen_random_uuid(),NEW.id,'active','In progress','active','#3b82f6',2),
        (gen_random_uuid(),NEW.id,'completed','Completed','completed','#22c55e',3),
        (gen_random_uuid(),NEW.id,'canceled','Canceled','canceled','#ef4444',4);
    RETURN NEW;
END;
$$;
CREATE TRIGGER workspaces_seed_statuses AFTER INSERT ON workspaces
FOR EACH ROW EXECUTE FUNCTION seed_workspace_statuses();

CREATE TABLE attribute_schemas (
    id uuid PRIMARY KEY,
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name text NOT NULL CHECK (length(trim(name)) > 0),
    value_type text NOT NULL CHECK (value_type IN ('text','number','date','single_select','multi_select','user')),
    position integer NOT NULL DEFAULT 0,
    archived_at timestamptz,
    UNIQUE (workspace_id, id)
);

CREATE TABLE project_attributes (
    workspace_id uuid NOT NULL,
    project_id uuid NOT NULL,
    attribute_id uuid NOT NULL,
    PRIMARY KEY (project_id, attribute_id),
    FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id,id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, attribute_id) REFERENCES attribute_schemas(workspace_id,id) ON DELETE CASCADE
);

CREATE TABLE attribute_options (
    id uuid PRIMARY KEY,
    workspace_id uuid NOT NULL,
    attribute_id uuid NOT NULL,
    option_key text NOT NULL,
    name text NOT NULL CHECK (length(trim(name)) > 0),
    position integer NOT NULL,
    archived_at timestamptz,
    UNIQUE (attribute_id, id),
    UNIQUE (attribute_id, option_key),
    FOREIGN KEY (workspace_id, attribute_id) REFERENCES attribute_schemas(workspace_id,id) ON DELETE CASCADE
);

CREATE TABLE task_attribute_values (
    workspace_id uuid NOT NULL,
    task_id uuid NOT NULL,
    attribute_id uuid NOT NULL,
    value jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (task_id, attribute_id),
    FOREIGN KEY (workspace_id, task_id) REFERENCES tasks(workspace_id,id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, attribute_id) REFERENCES attribute_schemas(workspace_id,id) ON DELETE CASCADE
);

CREATE INDEX workspace_status_order ON workspace_statuses(workspace_id,position) WHERE archived_at IS NULL;
CREATE INDEX attribute_schema_order ON attribute_schemas(workspace_id,position) WHERE archived_at IS NULL;
CREATE INDEX task_attribute_value_lookup ON task_attribute_values(attribute_id, value);
