-- A null locale means the user has not chosen a language; the server default can apply.
-- Existing English values were the old implicit default. Thai values were explicit choices.
UPDATE "user" SET locale = NULL WHERE locale = 'en';
ALTER TABLE "user" ALTER COLUMN locale DROP DEFAULT;
ALTER TABLE "user" ALTER COLUMN locale DROP NOT NULL;
