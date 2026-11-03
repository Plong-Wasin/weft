ALTER TABLE "runs" ALTER COLUMN "work_item_id" DROP NOT NULL;
ALTER TABLE "runs" ADD COLUMN "trigger_id" uuid REFERENCES "triggers"("id") ON DELETE SET NULL;
ALTER TABLE "triggers" ALTER COLUMN "event_type" DROP NOT NULL;
ALTER TABLE "triggers" ADD COLUMN "schedule" text;
ALTER TABLE "triggers" ADD COLUMN "expression" text;
ALTER TABLE "triggers" ADD COLUMN "next_run_at" timestamptz;
