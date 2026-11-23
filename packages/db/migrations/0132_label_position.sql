ALTER TABLE "labels" ADD COLUMN "position" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE "labels" SET "position" = ranked.position FROM (SELECT "id", (row_number() OVER (PARTITION BY "project_id" ORDER BY "name") - 1)::integer AS "position" FROM "labels") AS ranked WHERE "labels"."id" = ranked."id";
