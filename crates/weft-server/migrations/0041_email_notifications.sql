CREATE TABLE workspace_email_settings (
    workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
    enabled boolean NOT NULL DEFAULT false,
    enabled_at timestamptz,
    host text NOT NULL DEFAULT '',
    port integer NOT NULL DEFAULT 587 CHECK (port BETWEEN 1 AND 65535),
    security text NOT NULL DEFAULT 'starttls' CHECK (security IN ('none', 'starttls', 'tls')),
    username text NOT NULL DEFAULT '',
    password_ciphertext bytea,
    from_address text NOT NULL DEFAULT '',
    debounce_seconds integer NOT NULL DEFAULT 300 CHECK (debounce_seconds BETWEEN 0 AND 86400),
    retry_seconds integer NOT NULL DEFAULT 300 CHECK (retry_seconds BETWEEN 0 AND 86400),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE notification_emails (
    id uuid PRIMARY KEY,
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    recipient_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'failed', 'skipped')),
    attempts integer NOT NULL DEFAULT 0,
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    last_error text,
    skip_reason text,
    created_at timestamptz NOT NULL DEFAULT now(),
    sent_at timestamptz
);

CREATE INDEX notification_emails_due ON notification_emails(next_attempt_at) WHERE status = 'queued';
CREATE INDEX notification_emails_by_workspace ON notification_emails(workspace_id, created_at DESC);

ALTER TABLE notification_intents ADD COLUMN email_id uuid REFERENCES notification_emails(id) ON DELETE SET NULL;
CREATE INDEX notification_intents_pending_email ON notification_intents(recipient_id, task_id)
    WHERE email_id IS NULL AND retracted_at IS NULL;
CREATE INDEX notification_intents_by_email ON notification_intents(email_id) WHERE email_id IS NOT NULL;
