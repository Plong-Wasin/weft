ALTER TABLE vault_import_jobs
    DROP CONSTRAINT vault_import_jobs_vault_id_key;

CREATE UNIQUE INDEX vault_import_jobs_one_active_per_vault
    ON vault_import_jobs(vault_id)
    WHERE status IN ('queued', 'importing', 'reindexing');
