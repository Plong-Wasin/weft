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

**Bulk edit**:
One change applied to several selected work items of a project at once. It succeeds for all of them or for none. Assignees and labels are only added or removed, never replaced. Each work item still gets its own Activities, and the Activities of one Bulk edit are linked so the timeline can show they came together. It is not an Activity group, which folds repeated changes to one field of one work item.
_Avoid_: Batch, mass update

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

**Work item type**:
The kind of a work item, chosen per work item, with a name, icon, colour and one-line description. Every project has the neutral type Task, and a project can add more (the suggestions are plain words such as Bug, Request, Approval, Document and Big task). A project turns the feature on in Project settings > Features; while it is off every work item is Task. A type is a kind; a Label is a tag that many items can carry.
_Avoid_: Issue type, category, kind (unqualified)

**Custom property**:
A value a project defines once and a work item of one or more Work item types holds, with a kind: text, number, date, boolean, URL, dropdown, multi-select or person. A property can be required and have a default, and its kind does not change after creation. A work item shows only the properties of its own type, and changing its type asks before dropping the values of the others.
_Avoid_: Field, attribute, metadata

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

**Inline link**:
A clickable hyperlink inside rich text (a description, Comment, or Wiki page). Different from a Web Link, which is attached to a work item outside its text.
_Avoid_: Link (unqualified)

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
A rich-text document in the workspace's Wiki, not tied to any project. Every Wiki page lives in one Collection and may nest under another Wiki page of the same Collection. A Page can be moved into the Wiki and a Wiki page into a project, which turns it into a Page. Moving a Wiki page to another Collection takes its whole subtree along, and the moved page becomes a top-level page of that Collection; it never nests under a page of another Collection.
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

**Lock**:
The state of a Page or Wiki page that nobody can edit (content, title, or place in the Wiki) until it is unlocked. Only the page's owner or a workspace Admin can lock and unlock. Every writer is blocked the same way: people, the AI assistant, the CLI, and MCP. A locked page can still be deleted, archived, published, or shared by whoever already may.
_Avoid_: Freeze, read-only mode

**Archive**:
The state of a work item, Cycle, Module, or Project that is over and set aside. It is hidden from lists, boards, search, and queries unless the Archives page asks for it, it cannot be edited, and a restore brings it back unchanged. A work item can be archived only in a completed or cancelled state, outside a Cycle or Module that is still open.
_Avoid_: Soft delete, trash

**Automatic rule**:
A project setting, off until an admin turns it on, that the daily run applies as the system: an idle work item moves to a Done or Cancelled state (auto-close), or a done work item is archived (auto-archive). It never touches an item with a Run in progress or with recent activity. Each change is an Activity that gives its reason, notifies the assignees, and can be undone from the item's timeline.
_Avoid_: Automation, auto-close job, cron

**Burndown**:
The chart of work still open in a Cycle or Module, day by day, against a straight ideal line. It counts work items or, when the project has a points Estimate, Estimate points. A work item counts as done from the moment it entered a completed state.
_Avoid_: Burn-up, velocity

**Export**:
A file of a workspace member's work items, in CSV or JSON, made on request for chosen projects. It includes archived work items, leaves out Triage ones, and is downloadable for 7 days.
_Avoid_: Report, backup

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

**Notification email**:
An email about one notification (assignment, mention, comment reply, or the result of a Run on a work item), sent only to a person who chose that kind. It names the event and the item, never the comment text. Sent by the **Email digest**, not one email per notification.
_Avoid_: Alert, push

**Email digest**:
The batch that sends a person's waiting notification emails together, about every few minutes (EMAIL_DIGEST_MINUTES). One digest is one email per person. Email is off unless SMTP is configured; then nothing is queued for a person who chose no email kinds.
_Avoid_: Summary email, newsletter

**Sidecar**:
The AI chat opened as a side panel from a work item or wiki page, which passes that entity to the AI as its starting context. It is the same chat and history as the AI chat page.
_Avoid_: Inline assistant, copilot panel

**Activity**:
An append-only record of one change to a work item or a wiki page (field, old value, new value, actor, and the surface it came from: UI, AI, CLI, or MCP). Comments appear in a work item's timeline. The one exception: consecutive description edits by the same actor and surface within 5 minutes fold into one Activity.
_Avoid_: Audit entry, history row

**Activity group**:
Consecutive Activities on the same field, by the same actor and surface, each within 5 minutes of the one before and with no other actor's change between them. The timeline shows a group as one row, from the first old value to the last new value, with the number of changes and a way to expand the raw Activities. A group whose last value equals its first is hidden. Grouping only changes the display: Activities are never merged or deleted.
_Avoid_: Batch, session, burst (a Description Version is taken per burst)

**Outbound webhook**:
A web address in this workspace that receives signed JSON events from Weft: a work item is created or changed, a comment is added, or a Run finishes. A workspace Admin creates it, chooses its events, and sees its secret once. It ships off behind WEFT_OUTBOUND_WEBHOOKS_ENABLED; while off, nothing is sent or stored. Only people manage it, never an Agent.
_Avoid_: Integration, connected app, callback

**Webhook delivery**:
One event sent to one Outbound webhook, with its status, the receiver's answer and its attempts. A failed delivery is retried with growing waits, up to five more times; an Admin can redeliver it, which sends the same event (the same X-Weft-Delivery id) again.
_Avoid_: Notification, message, log entry

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
The user's explicit approval of a Write action the AI proposes, shown as a card in the chat. Each card is decided on its own, so the user can approve part of one answer (for example 2 of 3) and leave the rest pending. One card covers one Action call: a Bulk edit is one card for all its work items. A card still pending when the user sends a new message is **Superseded**: replaced by that message, not rejected, and the AI treats the message as a request to revise or re-propose.
_Avoid_: Approval, consent

**AI chat**:
A conversation between a user and the AI assistant. The AI acts with that user's permissions, and the activity log records "user via AI".
_Avoid_: Copilot, bot session

**Chat mode**:
The setting of an AI chat that decides what the AI may do. In Ask mode the AI runs Read actions only and, when asked to change anything, replies that it cannot in Ask mode. In Build mode the AI may also propose Write actions for Confirmation. In Autopilot mode the AI applies Write actions itself, within the limits of Autopilot.
_Avoid_: Permission level

**Autopilot**:
The way of working in which the AI applies Write actions without a Confirmation. A workspace Admin must allow Autopilot before a non-Guest member can pick it as the Chat mode of their own AI chat. An admin can also turn it on for a server-side Agent, and an Agent on a Runtime always works in Autopilot. An Agent can never delete anything, and the AI chat still needs a Confirmation for every deletion; deleting a project or a workspace is never open to the AI, and changes made in Autopilot never wake another Agent.
_Avoid_: Auto-approve, YOLO mode

**Web search**:
A per-chat switch that lets the AI look up the public web through its model provider. It is off by default, works in every Chat mode, and the AI cites the sources it used. It only reads: web content is information, never instructions, and any change still follows the Chat mode's Write rules.
_Avoid_: Browsing, internet access

**Agent**:
A workspace member that is not a person: it has a name, instructions, and a model, and an admin sets it up. It runs either on the Weft server or on one Runtime it is bound to. It can be assigned work items and mentioned in comments, and it counts as a project member only in projects an admin has opened to it. It never holds a lead, owner, or admin role.
_Avoid_: Bot, assistant (the AI chat is not an Agent), AI user

**Code-capable Agent**:
An Agent bound to a Runtime, so its Runs can read and change files on the Runtime owner's computer. An Agent that answers from the Weft server alone is not code-capable.
_Avoid_: Coding agent, local agent

**Agent access**:
The list of people allowed to assign or mention one Agent. For a Code-capable Agent it starts as the Runtime owner alone and the Runtime owner extends it person by person; for any other Agent it starts as every member of the projects the Agent is open to, and an admin narrows or extends it. Project write permission alone never grants it, so a project member without Agent access cannot start a Run of that Agent.
_Avoid_: Agent permission, invite list

**Daemon**:
A background program on one person's computer that signs in to a Weft server as that person, finds the agent CLIs installed there (for example Claude Code or Codex), and executes Runs for that person's Runtimes.
_Avoid_: Runner, worker (the server-side executor), machine

**Daemon credential**:
The restricted token a Daemon keeps in its own file. The server issues it at registration, it reaches `/api/daemon/*` only, expires after 30 days, and rotates when less than 7 days remain. It is not a Personal API token and cannot call `/actions`.
_Avoid_: Daemon token (ambiguous with the Personal API token)

**Runtime**:
One agent CLI of one Daemon under one permission profile, offered to one workspace. It belongs to the Daemon's owner and is private until the owner shares it with the workspace; only then can an admin bind Agents to it. One Runtime profile serves many Agents, and a Run of an Agent bound to an offline Runtime waits until it is back. Profiles are configured only by the Runtime owner and state the sandbox mode plus filesystem and network allowlists. A Runtime with sandbox enforcement enabled fails closed when a required sandbox tool is unavailable; it never falls back to full access.
_Avoid_: Runner, host, environment

**Run**:
One execution of an Agent, started by an assignment, a mention, or a Trigger. A Run acts on one work item, except a Run started by a schedule Trigger, which has none. A Run is queued, is dispatched when a Runtime takes it, runs, may wait for a Confirmation or for the user's answer, and ends completed, failed, cancelled, or stale. Its steps are kept as a transcript.
_Avoid_: Task, job, session

**Usage**:
The tokens and elapsed time of a Run, as the agent CLI or the provider reported them. A Run whose CLI printed no counts has unknown usage, which is shown as "Unknown", never as zero.
_Avoid_: Cost (cost is estimated from usage)

**Estimated cost**:
A Run's usage priced with the workspace's price table for the model the Run used, in US dollars. Unknown when the usage is unknown or the model has no price. It is an estimate, not an invoice.

**Monthly token budget**:
The most tokens an Agent's Runs may use in one UTC calendar month, counting Runs on the Weft server and on Runtimes alike. A Run that would start over budget is skipped and its requester is told why.
_Avoid_: Spend limit, quota

**Trigger**:
A rule an admin sets on an Agent, scoped to one project, that starts a Run without anyone assigning or mentioning the Agent. An event Trigger fires when a work item is created or updated, changes state or assignee, or gets a comment; a schedule Trigger fires daily, weekly, monthly, or on a cron expression. Changes made by an Agent never fire a Trigger.
_Avoid_: Automation, hook, rule (unqualified)

**Recurrence**:
A rule of one project that creates a new work item on a repeating schedule, from a saved work item template. Each round creates a fresh work item; the Recurrence never reopens an earlier one by itself (a user still can), and a round is created even when the previous work item is still open. A Recurrence keeps its own timezone. It is not a Trigger: a Trigger wakes an Agent, a Recurrence creates work.
_Avoid_: Recurring task, repeating issue, automation

**Originator**:
The person on whose behalf a Run acts: whoever assigned or mentioned the Agent, or for an automatic trigger the person who created the trigger. The Run has exactly that person's permissions, and every Confirmation it creates goes to that person.
_Avoid_: Requester, owner, invoker

**Skill**:
A named, reusable set of written instructions with a description that says what it does and when to use it. The AI sees only the name and description of the Skills available to it, and loads a Skill's instructions when the request matches or when the user picks it by typing `/` in the AI chat. A Skill only supplies text: it adds no permissions and skips no Confirmation. A Skill is personal (any non-Guest member creates it, only its creator can use it) or workspace-wide (only an admin creates it, every member can use it). An admin can attach workspace-wide Skills to an Agent, and a Run of that Agent can load only those Skills.
_Avoid_: Prompt template, macro, command, preset
