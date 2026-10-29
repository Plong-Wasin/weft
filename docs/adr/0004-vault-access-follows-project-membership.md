# ADR-0004: Model Vault access like Project membership

- **Status:** Accepted
- **Date:** 2026-10-29

## Context

Knowledge needs to be shared with the same explicit boundaries used for project work. A Vault may be restricted to a team, shared with a Workspace, or made available to the members of a Project without granting those Vault members access back to the Project.

## Decision

A Vault has a membership list with Viewer, Contributor, and Manager roles, following the Project membership model. A member can be a user, Team, or Project. Effective user access is the union of direct grants and grants through their Teams and Projects, capped by the user's Workspace role; a Workspace Viewer remains read-only. Adding a Project to a Vault grants the selected Vault role to that Project's current and future members in one direction only. Vault visibility is Restricted by default or Workspace-visible for read access; membership still controls writing and management.

## Alternatives considered

- **Make every Vault readable by all Workspace members by default.** Rejected because restricted Knowledge must not become visible merely because it belongs to a Workspace.
- **Support only direct user membership.** Rejected because it would duplicate team and project access administration and fail to follow changing membership.
- **Use a separate, incompatible Vault permission system.** Rejected because applying the familiar Project membership pattern keeps grants and effective access predictable.
- **Make Project membership in a Vault grant access back to the Project.** Rejected because Vault access must not imply access to unrelated Project content.

## Consequences

Every Knowledge read, search, rendered page, and zip download checks effective Vault access. Team and Project membership changes affect access immediately. Workspace Admin oversight of the Vault list does not grant permission to read its Knowledge contents.
