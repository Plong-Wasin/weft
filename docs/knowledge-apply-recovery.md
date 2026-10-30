# Recovering a Knowledge Apply

An approved note or file proposal first prepares a commit and records it in
`knowledge_apply_groups` in the same PostgreSQL transaction as the refreshed
Vault index. The server then advances the bare Vault repository's `main` ref
with compare-and-swap. If the server stops between those steps, startup recovery
retries the ref update. A ref that advanced independently is left untouched and
the proposal is marked `needs_attention` for its approver. The review screen shows the state; it is
never left as `applying`.

To inspect stuck applies, use the application database:

```sql
SELECT p.id AS proposal_id, p.workspace_id, p.status, g.vault_id,
       g.base_commit, g.prepared_commit, g.error
FROM proposals p
JOIN knowledge_apply_groups g ON g.proposal_id = p.id
WHERE g.state = 'needs_attention'
ORDER BY p.updated_at;
```

Check each Vault's `main` with `git --git-dir <repository_path> rev-parse
refs/heads/main`. If it is still at `base_commit`, restart Weft to retry the
recorded prepared commit. If it is at `prepared_commit`, restart Weft to mark
the apply complete. If it is at another commit, preserve that history and
investigate the Vault before changing refs; do not reset `main` or delete the
prepared object. The index remains available to readers during recovery.
