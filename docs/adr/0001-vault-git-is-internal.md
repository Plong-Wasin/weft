# ADR-0001: Keep each Vault's git repository internal to Weft

- **Status:** Accepted
- **Date:** 2026-10-29

## Context

A Vault is a set of Knowledge notes matching one Obsidian vault. Weft needs git history and git operations to prepare and apply approved Knowledge changes, but a public git interface would create another access path to secure, maintain, and keep consistent with Vault membership.

## Decision

Each Vault has its own internal git repository, operated only by Weft. There is no external git endpoint, push or clone access, git token, or git-host integration. People read Knowledge through Weft and can download a permission-checked zip snapshot; only Weft changes the repository through an approved Proposal. Backups include each repository and its Git LFS objects alongside PostgreSQL.

## Alternatives considered

- **Expose smart HTTP git access, authenticated by Weft tokens.** Rejected because it would allow direct reads or writes outside the Knowledge routes and approval flow, and require git-protocol authorization and hook behavior to match Vault membership.
- **Mirror Vaults to an external git host or support read-only clones.** Rejected for this release because it adds external access and synchronization behavior that is not needed for Weft's Knowledge and Proposal workflow. External hosting and clone access are deferred.
- **Store Knowledge without git.** Rejected because git supplies the per-Vault version history and commit/ref operations needed for reviewed changes and group Undo.

## Consequences

The server image and runtime must provide git and Git LFS. Weft owns repository lifecycle, history, and backup; users interact with Knowledge through Vault permissions and Weft routes, not git credentials.
