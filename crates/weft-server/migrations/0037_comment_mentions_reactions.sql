ALTER TABLE task_comments
    ADD COLUMN reply_to_comment_id uuid REFERENCES task_comments(id) ON DELETE SET NULL;

CREATE TABLE task_comment_mentions (
    workspace_id uuid NOT NULL,
    task_id uuid NOT NULL,
    comment_id uuid NOT NULL REFERENCES task_comments(id) ON DELETE CASCADE,
    recipient_id uuid NOT NULL,
    mention_key text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (comment_id, recipient_id),
    FOREIGN KEY (workspace_id, task_id) REFERENCES tasks(workspace_id, id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, recipient_id) REFERENCES workspace_memberships(workspace_id, user_id) ON DELETE CASCADE
);
CREATE INDEX task_comment_mentions_by_recipient ON task_comment_mentions(recipient_id, created_at DESC);

CREATE TABLE task_comment_reactions (
    workspace_id uuid NOT NULL,
    task_id uuid NOT NULL,
    comment_id uuid NOT NULL REFERENCES task_comments(id) ON DELETE CASCADE,
    user_id uuid NOT NULL,
    emoji text NOT NULL CHECK (length(emoji) BETWEEN 1 AND 16),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (comment_id, user_id, emoji),
    FOREIGN KEY (workspace_id, task_id) REFERENCES tasks(workspace_id, id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, user_id) REFERENCES workspace_memberships(workspace_id, user_id) ON DELETE CASCADE
);
CREATE INDEX task_comment_reactions_by_comment ON task_comment_reactions(comment_id, emoji);
