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

**Vault**:
A set of Knowledge notes kept in one internal git repository, matching one Obsidian vault. A Workspace has many Vaults. Like a Project, a Vault has members (users, Teams, or Projects) with a Viewer, Contributor, or Manager role.
_Avoid_: Repo, Wiki space

**Skill**:
An instruction that tells AI how the system and the team work. Managed in Weft itself (web), not stored in a Vault. Gives AI context only, never permissions.
_Avoid_: Prompt, Plugin, Rule

**Proposal**:
A complete, prepared set of changes (tasks, links, Knowledge edits, or any other write) that a user approves with one action. Nothing in it is applied before that approval.
_Avoid_: Draft, Suggestion, Plan

**Workspace**:
The boundary of data and members inside one Weft installation.
_Avoid_: Org, Tenant
