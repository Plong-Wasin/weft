# ADR-0002: Apply Proposal changes to PostgreSQL before moving Vault git refs

- **Status:** Accepted
- **Date:** 2026-10-29

## Context

A Proposal may change PostgreSQL records and Knowledge in one or more Vault repositories. PostgreSQL and git cannot participate in one shared transaction, while the person expects one Approve action and must never be left unaware of a partial apply.

## Decision

Apply is forward-only. Weft validates and prepares the git commits before mutation, then takes short per-Vault write locks in stable Vault-id order. It commits all database changes and the `applying` state in one PostgreSQL transaction, then advances each Vault's `main` ref with compare-and-swap. Once every ref advances, the Proposal becomes `applied`. A recovery job retries the git ref updates idempotently; Weft never rolls git back to hide a partially completed apply. Until recovery finishes, the Proposal remains visibly `applying` or becomes `needs_attention`. Group Undo preflights the entire database and git group before applying inverse database operations and git revert commits; any conflict prevents the whole Undo.

## Alternatives considered

- **Move git refs before committing PostgreSQL.** Rejected because a database failure would leave Knowledge visible without its corresponding task, Skill, or schema changes; git cannot be rolled back safely as if it shared the database transaction.
- **Attempt a compensating git rollback after a database commit.** Rejected because history must remain forward-only, and a crash during compensation could create another partially applied state.
- **Treat the cross-store operation as atomic and hide intermediate state.** Rejected because PostgreSQL and git have no shared atomic transaction; hiding that fact could leave a silent partial apply.
- **Undo whichever store succeeds first.** Rejected because compensation could overwrite later git history and would not guarantee whole-group conflict detection.

## Consequences

The apply state and prepared commit IDs must be durable in PostgreSQL. Recovery is an expected part of apply, and the approver and Workspace Admins can see when attention is needed. Git history records approved Knowledge changes as commits; group Undo creates revert commits instead of rewriting it.
