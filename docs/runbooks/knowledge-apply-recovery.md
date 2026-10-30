# Recovering a Vault Knowledge Apply

Weft commits the prepared change to PostgreSQL and the Vault index before it moves
the Vault's `main` ref. On startup, the recovery sweep retries an interrupted ref
move. It records `needs_attention` when `main` has moved to a different commit so
the Proposal remains visible to its approver and Vault members.

To list stuck applies, query the application database:

```sql
SELECT p.id AS proposal_id, p.workspace_id, p.status, g.vault_id,
       g.base_commit, g.prepared_commit, g.error
FROM proposals p
JOIN knowledge_apply_groups g ON g.proposal_id = p.id
WHERE g.state = 'needs_attention'
ORDER BY p.updated_at;
```

## Check the Apply

1. Open the Proposal and confirm its status. `applying` means startup recovery
   has not completed; `needs_attention` means the recorded compare-and-swap did
   not match the current Vault `main`.
2. Inspect the corresponding `knowledge_apply_groups` row using the Proposal ID,
   revision, and Vault ID. Compare `base_commit`, `prepared_commit`, and the
   Vault's `refs/heads/main` with `git --git-dir <repository-path> rev-parse
   refs/heads/main`.
3. Preserve the database and Vault repository before any manual investigation.
   A prepared commit is retained under `refs/weft/prepared/<commit>`.
4. Restart the Weft server to run recovery. If `main` is still at the recorded
   base commit, recovery advances it to the prepared commit. If `main` is already
   there, recovery marks the Apply complete. If it is elsewhere, recovery keeps
   `needs_attention` for an operator to reconcile.

Do not reset, force-move, or delete Vault refs to make the status look complete.
History is forward-only. After resolving a divergence, preserve the current
history and use a new approved Proposal for any additional content changes.

## Recovering an Interrupted Undo

Undo is also forward-only: it creates a revert commit and records it before
moving `main`. Restarting the server retries that ref move and rebuilds the
PostgreSQL index from the revert commit before marking the Proposal `undone`.
If another commit changed one of the files being reverted, Undo refuses the
entire group and returns the conflicting paths; review the current files and
submit a new Proposal instead of rewriting history.
