# API contract: Height-style task UX

All paths are under `/api/v1`. Requests that change data need the session cookie and the `x-csrf-token` header, like every other write. Errors with a body use `{"error": "<code>", "message": "<text>"}` (some omit `message`); a bare status means no body. Unknown JSON fields are ignored.

## 1. Status categories

Exactly five categories, fixed, in this display order:

| key           | name        | open or closed |
|---------------|-------------|----------------|
| `not_started` | Not started | open           |
| `active`      | In progress | open           |
| `blocked`     | Blocked     | open           |
| `wont_do`     | Won't do    | closed         |
| `completed`   | Completed   | closed         |

`canceled` no longer exists anywhere: it was renamed to `wont_do` (API responses, filters, overdue and Milestone progress rules). Status **keys** did not change, so an old Workspace may still have a Status named "Canceled" with key `canceled` whose category is `wont_do`. Milestone states (`planned, active, completed, canceled`) and AI run states are different concepts and keep `canceled`.

### `GET /workspaces/:ws/statuses`

```json
{
  "statuses": [
    {"id": "uuid", "key": "todo", "name": "Todo", "category": "not_started",
     "color": "#64748b", "position": 0, "archived": false, "is_default": true}
  ],
  "categories": [{"key": "not_started", "name": "Not started"}, "... five entries in display order"]
}
```

`position` is one order for the whole Workspace; group by `category` (in `categories` order) and sort by `position` inside a group to draw columns. Archived Statuses are included with `archived: true`.

A NEW Workspace has exactly three Statuses: `todo` "Todo" (`not_started`, default), `active` "In progress" (`active`), `completed` "Done" (`completed`). Workspaces that existed before keep their Statuses; their default is `backlog`.

### `POST /workspaces/:ws/statuses` (owner or admin)

Body `{"name": "Ready", "category": "blocked", "color": "#ff8800"?}` creates a Status in any of the five categories (key `custom_<uuid>`). 201 with the status object. Errors: 422 `invalid_category` (anything outside the five, including `canceled`), 422 empty name or bad color, 403 not owner/admin.

### `PATCH /workspaces/:ws/statuses/:id` (owner or admin)

Body fields, all optional: `name`, `color` (`#rrggbb`), `position` (integer), `is_default: true`, `category`.

- `category` may only repeat the current one. Any other value answers 422 `category_fixed` (`{"error":"category_fixed","category":"<current>"}`), or 422 `invalid_category` for a value outside the five. The database refuses it too.
- `is_default: true` makes this Status the one new Tasks start in; the previous default stops being it. Only a live `not_started` Status qualifies, else 422 `invalid_default_status`. `is_default: false` is 422 (name a new default instead).

### `POST /workspaces/:ws/statuses/reorder`

Body `{"status_ids": [ ...every non-archived Status id, once... ]}` sets `position` 0..n. 422 if the set differs.

### `POST /workspaces/:ws/statuses/:id/archive`

Unchanged, except the default Status cannot be archived: 422 `default_status`. Archiving a Status with Tasks still needs `{"replacement_id": "uuid"}` (422 `replacement_required`).

### New Task status

`POST /workspaces/:ws/tasks` without `status` (and JSON import, Templates without a Status) uses the Workspace default Status. 422 if the named Status is unknown or archived.

## 2. Manual order and the drag-and-drop move

Every Task has an integer `rank` (field `rank` in every Task JSON; a larger number is later). Siblings of one Project and parent (Project list, Subtasks) and the Tasks of one Status are ordered by it, so a single rank serves the list view, Subtask lists and every board column: the order inside a column is the global order filtered by Status. New Tasks go to the end. Treat `rank` as opaque and only compare it; the server may renumber.

A reorder is **not an edit**: it leaves `version` and `updated_at` alone, writes no History and cannot be undone. A Status change is an ordinary edit.

### `POST /workspaces/:ws/tasks/:number/move`

```json
{
  "expected_version": 3,
  "command_id": "uuid",
  "status": "active",
  "before_task_id": "uuid",
  "after_task_id": "uuid",
  "to_end": true,
  "list_id": "uuid"
}
```

All fields are optional but the request must name a `status`, a position or both (else 422 `empty_move`).

- Position: give at most one of `before_task_id`, `after_task_id`, `to_end: true` (else 422 `invalid_position`; a Task cannot be anchored to itself, also `invalid_position`). The anchor must be a sibling of the moved Task (same Project, same parent; a subtask reorders among its siblings only): otherwise 422 `anchor_not_in_scope`. A drop onto a board column sends `status` plus `before_task_id`/`after_task_id` of the neighbour in that column (or `to_end` for an empty or last slot). Without a position the rank stays and only the Status changes.
- `status`: a Status key. Unknown or archived: 422 `invalid_status`.
- `expected_version`: optional guard; a mismatch is 409 `{"error":"version_conflict","current":<task>}` and nothing changes.
- `command_id`: optional idempotency/undo handle, as on `PATCH /tasks/:id`.
- `list_id`: reorder inside a manual List (its own order, `kind: "manual"`) instead of among Project siblings. The Task and the anchor must be members: 422 `not_in_list` or `anchor_not_in_scope`; a smart List is 422 `not_a_manual_list`. A List reorder never touches the Project order.

The whole move (status change, completed-at stamp, History, next recurring occurrence, rank) is one transaction: a refused move changes nothing.

Response 200:

```json
{
  "task": { "...full Task JSON incl. rank, status, version, completed_at..." },
  "tasks": [ "same Task, as a list for future multi-task moves" ],
  "group_id": "uuid or null",
  "status_changed": true,
  "reordered": true
}
```

`group_id` is the Operation group of the Status change (null for a pure reorder). `reordered` is false when the rank did not change (status-only move, or already in place).

Errors: 401 no session; 403 `{"error":"forbidden"}` when the caller can read the Project but not write; 404 when the Task does not exist, is archived or the caller cannot read the Project; 409 `version_conflict`; 422 as above.

### History and Undo

- Pure reorder: nothing in `GET /tasks/:id/history`, no Operation group, `version` unchanged.
- Status change: one Operation group with `status` (and `completed_at` when the Task enters or leaves a `completed` Status). It shows once in History and `POST /workspaces/:ws/history/undo` / `redo` restore it like any edit. Undo restores the Status only; the Task keeps its new place in the order.

## 3. Sorting

### `GET /workspaces/:ws/tasks`

New or changed query parameters:

- `sort`: `manual` (default; rank, then number), `number`, `title`, `status` (Workspace status order, not alphabetical), `priority` (low < normal < high < urgent), `start_date`, `due_date`, `created_at`, `updated_at`, `completed_at`, or `attribute/<attribute_id>` (also `attribute:<id>`; numbers sort as numbers).
- `direction`: `asc` (default) or `desc`. Empty values (no due date, no attribute value) sort last in both directions; ties fall back to rank, then number.
- Unknown `sort` or `direction`: 422 `{"error":"invalid_sort"}`. (Before, an unknown `sort` was silently ignored.)

Existing filters (`status`, `project_id`, `attribute_id`, `attribute_value`, `from`/`to`, `milestone_id`, `overdue`, `blocked`, `archived`) and `group_by`/`columns` are unchanged.

### Saved views (Lists) and CSV export

A Smart List's `query.sort` rules accept the extra fields `manual`, `created_at`, `updated_at`, `completed_at` (plus the old ones and `attribute:<id>`); CSV export uses the same rules.

## 4. Custom attributes

`POST /workspaces/:ws/attributes` (owner or admin) takes `value_type` in `text`, `number`, `date`, `single_select`, `multi_select`, `user` (select types need non-empty `options`). Any number of attributes can be created; a Sprint is a `date` attribute. Unchanged otherwise: `{"name","value_type","project_ids"?,"options"?}`. Values are set with `PATCH /tasks/:id/attributes` `{"values":[{"attribute_id","value"}]}`.

## 5. Visible columns

Built-in column names: `number, title, project, status, priority, start_date, due_date, created_at, updated_at, completed_at, assignees, milestone, milestone_state, recurrence`; a custom attribute is `attribute:<attribute_id>`.

### Saved Lists

`query.columns` of a List (`POST /workspaces/:ws/lists`, `PATCH .../lists/:id`) is validated: an array of at most 40 known column names (422 `invalid_query` with a message otherwise). A manual List may now carry `columns` (and `group`), but still no filters and no sort rules. Send the full query shape `{"filters":[],"logic":"and","sort":[],"group":null,"columns":[...]}`.

### Project views, per person

`GET /projects/:project_id/view-settings` returns

```json
{"project_id": "uuid", "stored": false,
 "settings": {"columns": ["title","status","priority","due_date"], "sort": "manual", "direction": "asc", "group_by": null}}
```

(`stored` is false and `settings` is the default until the caller saves.) `PUT` the same path with `{"columns": [...], "sort"?, "direction"?, "group_by"?}` replaces the caller's settings and returns the same shape with `stored: true`. `sort` takes the values of section 3, `group_by` is `status` or a column name. Settings are per person and per Project; any reader of the Project may keep them. Errors: 422 `invalid_settings`, 404 when the caller cannot read the Project.
