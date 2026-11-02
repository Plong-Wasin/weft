# Weft

An AI-native project management tool with a Plane-like UI. Teams track work items and write wiki pages; an AI assistant reads the data and proposes changes that a human confirms.

## Language

**Workspace**:
The top-level tenant. A user can belong to many workspaces; all data is scoped to one.
_Avoid_: Organization, team, account

**Project**:
A container of work items inside a workspace, with its own states, labels, and key.
_Avoid_: Board, repo

**Work item**:
The unit of work tracked in a project, with a state, priority, assignees, and labels.
_Avoid_: Issue, ticket, task

**Project key**:
The short uppercase code of a project (for example `MOB`). A work item displays as the project key plus its number in the project (`MOB-231`). The key can be renamed.
_Avoid_: Identifier, prefix, slug

**Sub-work item**:
A work item whose parent is another work item.
_Avoid_: Subtask, child issue

**State**:
The position of a work item in its project's workflow.
_Avoid_: Status

**Label**:
A project-scoped tag attached to work items.
_Avoid_: Tag

**Cycle**:
A time-boxed period of work in one project, with a start date and an end date. A work item belongs to at most one cycle. A cycle is upcoming, active, or completed according to today's date. Unfinished work stays in a completed cycle until someone transfers it.
_Avoid_: Sprint, iteration

**Module**:
A project-scoped group of work items around one topic or feature, with a lead, members, and a status chosen by hand. A work item can belong to many modules.
_Avoid_: Epic, feature group

**Intake**:
The inbox of a project where work items are submitted before the project accepts them. Each submission is an intake item with an outcome: pending, accepted, rejected, snoozed, or duplicate.
_Avoid_: Inbox, backlog, requests

**Triage state**:
The single system state of a work item that is in intake and not yet accepted. Users cannot add or remove it, and it keeps the work item out of normal lists and search.
_Avoid_: Pending state

**Relation**:
A typed link between two work items of the same project: blocks and blocked by (a pair), duplicate, or relates to.
_Avoid_: Dependency, link (unqualified)

**Comment**:
A rich-text message on a work item, written and editable only by its author. A comment may have replies one level deep.
_Avoid_: Note, remark

**Reply**:
A comment whose parent is another comment. A reply cannot have replies.
_Avoid_: Thread, sub-comment

**Wiki page**:
A rich-text document in the workspace's wiki, optionally linked to projects.
_Avoid_: Doc, note, page (unqualified)

**Pages**:
The wiki pages linked to one project, listed under that project's Pages menu. Not a separate entity: the workspace Wiki lists every wiki page, Pages lists the ones linked to the project.
_Avoid_: Project docs

**Layout**:
A way of displaying a list of work items: list, board, or spreadsheet.
_Avoid_: View (that is a saved view), mode

**View**:
A saved set of filters (a PQL query), a layout, grouping, and ordering, scoped to one project or to the workspace, and public or private to its owner. A view never changes the underlying work items.
_Avoid_: Saved filter, perspective

**Asset**:
An uploaded file (attachment, inline image, avatar, cover, logo) tied to one owning entity.
_Avoid_: Upload, media, file (unqualified)

**Sidecar**:
The AI chat opened as a side panel from a work item or wiki page, which passes that entity to the AI as its starting context. It is the same chat and history as the AI chat page.
_Avoid_: Inline assistant, copilot panel

**Activity**:
An append-only record of one change to a work item or a wiki page (field, old value, new value, actor, and the surface it came from: UI, AI, CLI, or MCP). Comments appear in a work item's timeline.
_Avoid_: Audit entry, history row

**Personal API token**:
A revocable credential owned by one user that lets the CLI or MCP act with that user's permissions. It has a name, an optional description, and an optional expiry; after expiry it stops working like a revoked one. It is shown once, when created.
_Avoid_: API key, service account

**OAuth grant**:
A user's standing permission for one external app (an OAuth client such as Claude) to act with that user's permissions across all of the user's workspaces. It lasts until the user revokes it. Shown to the user as an "Authorized app".
_Avoid_: Connected app, integration

**Action**:
A named operation on workspace data (for example "create work item") with a permission check. The UI, the AI chat, the CLI, and MCP all invoke the same Actions.
_Avoid_: Tool, command, endpoint

**Write action**:
An Action that creates, changes, or deletes data. When the AI proposes one, the user must confirm it first.
_Avoid_: Mutation

**Read action**:
An Action that only reads data. The AI runs it without confirmation.
_Avoid_: Query

**Confirmation**:
The user's explicit approval of the Write actions the AI proposes, shown as a card in the chat.
_Avoid_: Approval, consent

**AI chat**:
A conversation between a user and the AI assistant. The AI acts with that user's permissions, and the activity log records "user via AI".
_Avoid_: Copilot, bot session

**Chat mode**:
The setting of an AI chat that decides what the AI may do. In Ask mode the AI runs Read actions only and, when asked to change anything, replies that it cannot in Ask mode. In Build mode the AI may also propose Write actions for Confirmation.
_Avoid_: Permission level, autopilot (a later, separate mode)
