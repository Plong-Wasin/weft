# ADR-0006: Knowledge changes do not notify

- **Status:** Accepted
- **Date:** 2026-10-30

## Context

A Knowledge change is an applied Proposal that edits or adds a note or file in a Vault, or the revert that undoes it. Task notifications (Inbox and Watchers) are filtered by Project access. Vault access follows Project membership (ADR-0004) but is a separate check, so a notice about a note could name a note, a path or a Vault to someone who cannot read it. A Task that references a note does not grant access to it.

## Decision

A Knowledge change creates no Notification, for anyone: not Vault members, not Watchers of a Task that references the note, not the approver. Applying and undoing a Knowledge change leave every Inbox unchanged. People find changes through the Vault history and the Proposal itself, which already check Vault access.

The Inbox never carries a note title, path, snippet or Vault name. Notification rows exist only for Tasks and are filtered by Project access at read time.

## Alternatives considered

- **Notify Vault members.** Rejected for this release: noisy for large Vaults, and needs a per-Vault mute, grouping and retraction on revert before it is safe.
- **Notify Watchers of Tasks that reference the changed note.** Rejected: it would tell a Task reader that a note they may not be able to read changed, revealing its existence. It would also make a reference behave like a subscription.
- **Opt-in per Vault.** Deferred. It can be added later without changing this default, as a new notification reason with its own access check, retraction on revert and tests.

## Consequences

No Inbox entry needs retraction when a Knowledge change is undone, because none is created. A future opt-in must filter by Vault access at read time and at send time, and retract unread entries when the change is reverted. A test (`knowledge_notifications.rs`) pins the default: apply and undo leave notification rows unchanged and the Inbox free of note data.
