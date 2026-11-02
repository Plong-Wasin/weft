ALTER TABLE api_tokens ADD COLUMN description text;
--> statement-breakpoint
ALTER TABLE api_tokens ADD COLUMN expires_at timestamptz;
