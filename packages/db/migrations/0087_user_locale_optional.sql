-- A null locale means the user has not chosen a language; the server default can apply.
-- Existing English values were the old implicit default. Thai values were explicit choices.
-- The constraint must go before the UPDATE writes NULLs, or rows holding 'en' violate NOT NULL.
ALTER TABLE "user" ALTER COLUMN locale DROP DEFAULT;
ALTER TABLE "user" ALTER COLUMN locale DROP NOT NULL;
UPDATE "user" SET locale = NULL WHERE locale = 'en';
