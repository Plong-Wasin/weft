CREATE TABLE weft_installation (
    id smallint PRIMARY KEY CHECK (id = 1),
    installed_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO weft_installation (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
