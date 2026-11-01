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

**Wiki page**:
A rich-text document in the workspace's wiki, optionally linked to projects.
_Avoid_: Doc, note, page (unqualified)

**Asset**:
An uploaded file (attachment, inline image, avatar, cover, logo) tied to one owning entity.
_Avoid_: Upload, media, file (unqualified)

**Sidecar**:
The AI chat opened as a side panel from a work item or wiki page, which passes that entity to the AI as its starting context. It is the same chat and history as the AI chat page.
_Avoid_: Inline assistant, copilot panel

**Activity**:
An append-only record of one change to a work item (field, old value, new value, actor, and the surface it came from: UI, AI, CLI, or MCP). Comments appear in the same timeline.
_Avoid_: Audit entry, history row

**Personal API token**:
A revocable credential owned by one user that lets the CLI or MCP act with that user's permissions.
_Avoid_: API key, service account

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
