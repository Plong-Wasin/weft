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

**Estimate**:
The scale a project uses to size work items: a set of 2 to 6 Estimate points, either numbers (points) or text (categories). A project has at most one active Estimate, and a project Admin turns it on or off.
_Avoid_: Sizing, story-point scheme

**Estimate point**:
One value of a project's Estimate. A work item holds at most one Estimate point.
_Avoid_: Story point, size, effort

**Relation**:
A typed link between two work items of the same project: blocks and blocked by (a pair), duplicate, or relates to.
_Avoid_: Dependency, link (unqualified; a URL attachment is a Web Link)

**Web Link**:
An http(s) URL, with an optional title, attached to one work item. Shown as "Add link" in the UI.
_Avoid_: Link (unqualified), bookmark, external relation

**Description Version**:
A snapshot of a work item's description taken before an editing burst (at most one per 5 minutes) or before a restore, so the state before the edits can be restored.
_Avoid_: Revision, history entry

**Comment**:
A rich-text message on a work item, written and editable only by its author. A comment may have replies one level deep.
_Avoid_: Note, remark

**Reply**:
A comment whose parent is another comment. A reply cannot have replies.
_Avoid_: Thread, sub-comment

**Page**:
A rich-text document that belongs to exactly one project and is visible only to that project's members. Listed under the project's Pages menu. A Page is either shared with every project member or private to its author.
_Avoid_: Project doc, project wiki page

**Wiki page**:
A rich-text document in the workspace's Wiki, not tied to any project. Every Wiki page lives in one Collection and may nest under another Wiki page of the same Collection. A Page can be moved into the Wiki and a Wiki page into a project, which turns it into a Page.
_Avoid_: Doc, note, page (unqualified)

**Collection**:
A named top-level group of Wiki pages in the workspace, public or private. A private Collection is visible only to the people it is shared with.
_Avoid_: Folder, space, category

**Share**:
A grant that gives one workspace member view, comment, or edit access to a Wiki page. Pages in a project are never shared individually: their access follows project membership.
_Avoid_: Permission, invite

**Published link**:
A public, read-only address of a Wiki page that anyone can open without signing in. The owner or a workspace Admin can revoke or renew it. A Page and a private Wiki page cannot be published.
_Avoid_: Public page, share link

**Layout**:
A way of displaying a list of work items: list, board, spreadsheet, calendar, or gantt.
_Avoid_: View (that is a saved view), mode

**Group-by**:
The property that splits a layout's work items into groups: state, priority, assignee, label, cycle, module, creator, or due date. A work item with several values (assignees, labels, modules) appears under each of them, and under "none" when it has no value. Due date groups are fixed buckets: overdue, today, this week, next week, later, and no due date.
_Avoid_: Swimlane (that is a sub-group on a board), bucket

**Sub-group**:
A second grouping inside each group, shown as swimlanes on a board and nested sections in a list. It never repeats the group-by property, and spreadsheet, calendar, and gantt do not use it.
_Avoid_: Swimlane, nested group

**Calendar**:
A layout that places work items on a month grid by due date. Work items without a due date wait in a side list.

**Gantt**:
A layout that draws each work item as a bar from start date to due date on a timeline. Work items without any date wait in a side list.
_Avoid_: Timeline


**View**:
A saved set of filters (a PQL query), a layout, group-by, sub-group, and ordering, scoped to one project or to the workspace, and public or private to its owner. A view never changes the underlying work items.
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

**Agent**:
A workspace member that is not a person: it has a name, instructions, and a model, and an admin sets it up. It can be assigned work items and mentioned in comments, and it counts as a project member only in projects an admin has opened to it. It never holds a lead, owner, or admin role.
_Avoid_: Bot, assistant (the AI chat is not an Agent), AI user

**Run**:
One execution of an Agent on one work item, started by an assignment, a mention, or later a trigger. A Run is queued, runs, may wait for a Confirmation or for the user's answer, and ends completed, failed, cancelled, or stale. Its steps are kept as a transcript.
_Avoid_: Task, job, session

**Originator**:
The person on whose behalf a Run acts: whoever assigned or mentioned the Agent, or for an automatic trigger the person who created the trigger. The Run has exactly that person's permissions, and every Confirmation it creates goes to that person.
_Avoid_: Requester, owner, invoker

**Skill**:
A named, reusable set of written instructions with a description that says what it does and when to use it. The AI sees only the name and description of the Skills available to it, and loads a Skill's instructions when the request matches or when the user picks it by typing `/` in the AI chat. A Skill only supplies text: it adds no permissions and skips no Confirmation. A Skill is personal (any non-Guest member creates it, only its creator can use it) or workspace-wide (only an admin creates it, every member can use it). An admin can attach workspace-wide Skills to an Agent, and a Run of that Agent can load only those Skills.
_Avoid_: Prompt template, macro, command, preset
