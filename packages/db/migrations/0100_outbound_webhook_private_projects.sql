-- Outbound webhooks never receive events from private projects unless the Admin opts the endpoint in, and even then only
-- for projects the creating Admin can see. A delivery records its project so visibility is checked again at send time.
ALTER TABLE outbound_webhooks ADD COLUMN include_private_projects boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE outbound_webhook_deliveries ADD COLUMN project_id uuid REFERENCES projects(id) ON DELETE CASCADE;
