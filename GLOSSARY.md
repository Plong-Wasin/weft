# Weft

Self-hosted, AI-first work management for teams: tasks, a git-backed knowledge base, and AI that works through the same permissions as people.

## Language

**Knowledge**:
Markdown notes in a Vault, shown on the web and readable by people and AI. Changed only by AI through an approved Proposal; people never edit them directly. Replaces the earlier "Documents/Wiki" exclusion.
_Avoid_: Document, Wiki, Docs

**Team**:
A named group of users inside a Workspace, with no roles of its own. Used to tell AI who belongs where, to grant access, to mention it, and to hold assigned work nobody has taken yet. A user can belong to many Teams.
_Avoid_: Group, Squad

**Assignee**:
A user or a Team responsible for a Task. A Task has a set of Assignees; any one of them may close it.
_Avoid_: Owner, Responsible

**Status**:
A Workspace-wide label for where a Task stands. Every Status belongs to exactly one of five fixed categories: Not started, In progress, Blocked, Won't do or Completed. The category can never change and no sixth category exists; names, colors and order are free. A new Workspace starts with Todo, In progress and Done, and a new Task starts in the Workspace's default Status.
_Avoid_: State, Stage, Canceled (the old name of Won't do)

**Vault**:
A set of Knowledge notes kept in one internal git repository, matching one Obsidian vault. A Workspace has many Vaults. Like a Project, a Vault has members (users, Teams, or Projects) with a Viewer, Contributor, or Manager role.
_Avoid_: Repo, Wiki space

**Skill**:
An instruction that tells AI how the system and the team work. Managed in Weft itself (web), not stored in a Vault. Gives AI context only, never permissions.
_Avoid_: Prompt, Plugin, Rule

**Proposal**:
A complete, prepared set of changes (tasks, links, Knowledge edits, or any other write) that a user approves with one action. Nothing in it is applied before that approval.
_Avoid_: Draft, Suggestion, Plan

**Reference**:
A link in Task text to another Task or a Knowledge note. A Reference identifies its target, but does not grant access, subscribe anyone, or send a notification.
_Avoid_: Mention

**Backlink**:
A Reference from another Task or comment to the current Task, shown only when the viewer can read both Tasks.
_Avoid_: Incoming link

**Mention**:
A reference to a Workspace member or Team in discussion text, resolved for people who can read the Task.
_Avoid_: Reference

**Reaction**:
An emoji acknowledgement attached to a comment.
_Avoid_: Vote

**Watcher**:
A Workspace member who chooses to receive selected updates about a Task. Watching does not grant access.
_Avoid_: Subscriber

**Inbox**:
A member's list of notifications that they can read, manage and dismiss.
_Avoid_: Feed

**Notification**:
A permission-filtered notice about an event relevant to a member, such as an assignment, mention, reply or watched Task update.
_Avoid_: Alert

**Knowledge change**:
An applied Proposal that edits or adds a note or file in a Vault, or the revert that undoes it. A Knowledge change creates no Notification, for Vault members or for Watchers of referencing Tasks (ADR-0006).
_Avoid_: Note update notice

**Workspace**:
The boundary of data and members inside one Weft installation.
_Avoid_: Org, Tenant
