# Collaboration and context

How Weft members discuss work, how they are told about it, how browsers stay in sync, how AI uses
that context, and where it stops. Every statement here is covered by an API or browser test; the
tests are named at the end. Vocabulary is in `GLOSSARY.md`; decisions are in `docs/adr/`.

Access rule for everything below: a mention, a reference, watching or an assignment never grants
access. Every read re-checks Workspace membership, Project access and Vault membership.

## Mentions and references

- Comments and Task descriptions are Markdown, rendered and sanitised on the server only. Clients
  never decide what is a reference or a mention.
- `#123` becomes a chip with the Task title and status when the caller can read that Task. A number
  the caller cannot read, or that does not exist, stays plain text, so a reference cannot probe for
  hidden Tasks. Code, inline code, `\#123`, URL fragments and headings are left alone.
- A Task URL from the same Workspace that is pasted into text is treated like `#123`.
- A Task shows "Referenced from" with the source Task or comment. The list is rebuilt when a comment
  is posted, edited or deleted, or a Task edit is undone, and repeats count once. It lists only
  sources the caller can read.
- `[[` opens a search of notes the caller can read and inserts a note reference. The chip shows the
  note title and Vault; a caller who cannot read the Vault sees neutral text. A note reference follows
  a rename or move made by Apply and reads "note deleted" after a delete. References to notes are
  one way: notes have no Task backlinks, and `#123` inside a note stays text.
- `@name` mentions people who can read the Task when the comment is posted; `@team` expands to the
  Team members at that moment, again limited to readers. Mentions are resolved once, at post time.
- Comments can be quoted or replied to, get emoji reactions, carry attachments (up to 10 MiB each,
  served through an access-checked route, never as trusted HTML or SVG), and can become a new Task
  with a link back to the message. Retrying a post with the same request id does not duplicate it.

## Notifications and email

- The Inbox lists, per Task, assignments, mentions, replies and the events a person chose by watching
  the Task. Assigning a Team does not notify its members. Repeated events on one Task are grouped.
- A person can mark entries read, dismiss them and mute a Task.
- An unread entry caused by an action that is later undone disappears (retraction). Email that was
  already sent is not recalled.
- An entry never carries a title, snippet or preview of something the reader cannot read. The check
  runs when the Inbox is read and when email is sent.
- Knowledge changes notify no one (ADR-0006).

SMTP email is optional and off by default. A Workspace admin turns it on under the Workspace email
settings (`/api/v1/workspaces/{id}/email`): host, port, security (`none`, `starttls`, `tls`),
username, password (stored encrypted), from address, a debounce (default 300 s) for attribute-change
emails, and a retry delay (default 300 s). **Send test email** (`/email/test`) checks the settings.
A failed send is retried up to 3 times and then stays visible with its error in the delivery list
(`/email/deliveries`). Attribute-change emails are merged within the debounce window; assignments,
mentions and replies are sent when queued.

## Realtime

- One server-sent events stream per Workspace: `GET /api/v1/workspaces/{id}/realtime/events?after=N`,
  and a snapshot at `/realtime/snapshot`. Events come from an outbox written in the same transaction
  as the change, so delivery is at least once; clients deduplicate by event id and treat an event as a
  hint to reload, never as a patch.
- Tasks, history, comments, reactions, Proposals and runs update in every open browser. Undo,
  compaction and deletion revise or remove what other browsers already show.
- After a reconnect the snapshot carries tombstones for removed, archived and no-longer-visible items,
  so nothing ghostly stays on screen.
- Removing someone's access closes their stream and clears their cached scope. Losing a Project drops
  its Tasks from the screen; losing the Workspace signs the screen out.
- A lost connection shows a banner. Writes are never queued offline; they need a server response.
- Presence, typing and read receipts are not provided.

## AI context

- A run starts from a Task, its chat and related Tasks. The preview lists the Sources before anything
  is sent to a provider. A run sees what the initiator can read, narrowed by the selected scope and
  the connection grants; text from Tasks, comments and notes is labelled untrusted data and is never
  an instruction.
- Budgets apply to the run: tool calls, characters and the number of comments read from a thread. A run
  that read only part of a thread says so, and a summary says which Sources it used.
- AI can summarise a discussion, point out likely duplicates (it never merges or closes anything),
  review a Task for missing detail, and search and read notes. Its only outputs are text and
  Proposals. It has no write or approve capability: a signed-in person approves every change.
- Revoking access mid-run takes effect on the next tool call: tools return nothing for what is no
  longer readable, and Apply refuses.

## Knowledge apply and recovery

AI proposes note edits (a small diff against the file's base hash), file additions (previewed) and
renames with their link fixes in the same Proposal. Approval takes the Vault lock, prepares the merge
commit, writes the database and the Vault index in one transaction, and only then moves the git ref
(ADR-0002). Undo is a revert commit and refuses the whole group when the file changed since.

If the server stops between the transaction and the ref move, startup recovery finishes the Apply. If
the ref was moved by someone else, recovery does not touch history: the Proposal and its Vault group
become `needs_attention`, the review screen says so, and the steps in
`docs/knowledge-apply-recovery.md` apply. A stuck Apply is never left looking in progress.

## HTML pages in Vaults

A Vault may hold a whole HTML page. It is served only from `/api/v1/vault-pages/{vault}/{path}` after
a Vault access check, with `Content-Security-Policy: sandbox allow-scripts; default-src 'none'; ...;
connect-src 'none'; form-action 'none'`, shown in an iframe with `sandbox="allow-scripts"` and a
label. Scripts run; the page cannot read cookies or its parent, send requests, submit forms, open
windows or frame another Vault. A Proposal that adds a page shows a sandboxed preview and says it
contains scripts (ADR-0005).

## Known limits

- Posting a comment is not an undoable Operation; edit or delete it with its own controls. Undo covers
  Task edits and creating a Task from a message. Reactions toggle themselves.
- Search is `ILIKE` substring matching with 1-100 characters and at most 8 terms. There is no Thai word
  segmentation.
- Email already sent cannot be recalled. SMTP is the only transport.
- A Vault page's sandbox lowers risk but is not a guarantee against every browser exfiltration path.
- MCP reads are not recorded as Proposal sources, the MCP rate limiter is in memory, and stale
  detection uses `updated_at`.
- Realtime has no presence. A reconnect reloads state instead of replaying every missed event.
- JSON import is for Tasks only and always starts as a dry run.

## Tests

- `crates/weft-server/tests/collaboration_exit_gate.rs`: leaks, mid-run revocation, stuck Apply,
  release names.
- `apps/web/collaboration-exit-gate.e2e.test.mjs`: two browsers, keyboard and phone width.
- `apps/web/html-sandbox.e2e.test.mjs`: the sandbox in a real browser.
- Manual checks for a person: `docs/runbooks/collaboration-manual-checks.md`.
