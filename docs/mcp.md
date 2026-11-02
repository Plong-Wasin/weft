# MCP server

The MCP server lets an external AI client (Claude Code, Claude Desktop, Cursor, ...) use your workspace. It exposes every Action in the registry as a tool, except `delete_project`, `delete_workspace`, `create_workspace`, and token management. Tool schemas come from the Action input schemas.

- Auth: a Personal API token sent as `Authorization: Bearer <token>`. Create one while signed in (`create_api_token`); revoking the token cuts the client off. OAuth access tokens are supported by the HTTP endpoint.
- Permissions: the token acts with its owner's permissions. Write actions run immediately with no Confirmation card; the client decides whether to ask you first.
- Workspace: tools that act inside a workspace take a `workspace` argument (the slug).
- Activity: changes are recorded with source `mcp`.

## Phase 2 tools

Every Action below is a tool, with the same permission checks as the web UI. MCP runs Write tools at once (no Confirmation card), so ask the user before calling one.

| Area | Read tools | Write tools |
| --- | --- | --- |
| Cycles | `list_cycles`, `get_cycle`, `check_cycle_dates` | `create_cycle`, `update_cycle`, `add_cycle_items`, `remove_cycle_items`, `transfer_cycle_items`, `archive_cycle`, `delete_cycle` |
| Modules | `list_modules`, `get_module` | `create_module`, `update_module`, `add_module_items`, `remove_module_items`, `archive_module`, `unarchive_module`, `delete_module` |
| Views | `list_views`, `get_view` | `create_view`, `update_view`, `delete_view` |
| Intake | `list_intake_items` | `submit_intake_item`, `update_intake_item`, `accept_intake_item`, `reject_intake_item`, `snooze_intake_item`, `duplicate_intake_item` |
| Relations | `list_work_item_relations` | `create_work_item_relation`, `remove_work_item_relation` |
| Comments | `list_comments`, `list_timeline`, `list_comment_versions` | `create_comment` (give `parentId` to reply, one level deep) |
| Project settings | | `set_project_features` (turn Cycles, Modules, Intake on or off; project Admin) |

- Intake work items stay out of `list_work_items`, `search_work_items`, Cycles, and Modules until accepted. Use `list_intake_items` to see them.
- A project with a feature turned off refuses that feature's tools (400).
- `list_comment_versions` works only for the comment's author and workspace Admins.

### Querying work items

`list_work_items` takes a PQL query in `query` (one project). `search_work_items` takes free text in `query`, and a PQL query in `pql` together with `projectId`. The two `query` fields are different: only the one on `list_work_items` is PQL.

Syntax: `Field Operator Value`, combined with `AND`, `OR`, `NOT`, and parentheses, then optional `ORDER BY field [ASC|DESC]` and `LIMIT n` (max 1000).

- Fields: `title`, `text`, `id`, `state`, `stateGroup`, `priority`, `assignee`, `label`, `cycle`, `module`, `mention`, `createdBy`, `project`, `startDate`, `dueDate`, `createdAt`, `updatedAt`.
- Operators: `=`, `!=`, `~`, `IN`, `NOT IN`, `<`, `<=`, `>`, `>=`, `BETWEEN a AND b`, `IS NULL`, `IS NOT NULL`.
- Functions: `currentUser()`, `today()`, `startOfWeek()`, `endOfWeek()`, `activeCycle()`, `openStates()`, `closedStates()`, `isOverdue()`, `hasNoAssignee()`, `hasNoLabel()`.
- State, label, assignee, Cycle, and Module are written by name and resolved inside the project. An error names the character position and the reason.

```text
priority IN (urgent, high) AND assignee = currentUser() AND dueDate < today() ORDER BY dueDate LIMIT 20
cycle = activeCycle() AND stateGroup != completed AND hasNoAssignee()
module = "Mobile app" AND label = bug AND cycle IS NULL ORDER BY priority DESC
```

## Client setup

The MCP server supports stdio and Streamable HTTP. Both use the same tools and call the Weft API.

### HTTP

With the Compose stack, the HTTP endpoint is available at `https://<weft>/mcp` through the reverse proxy. Set `WEFT_PUBLIC_URL` to that public origin (for example, `https://weft.example`); route `/mcp` to the MCP service and `/api` to the API. Add the token as a Bearer credential in your MCP client. Requests are stateless, and the API validates the token on every request. Missing or rejected credentials receive `401` with a Bearer challenge.

### Stdio

For local clients, stdio remains available and calls the Weft API over HTTP.

```json
{
  "mcpServers": {
    "weft": {
      "command": "bun",
      "args": ["/path/to/weft/apps/mcp/src/index.ts"],
      "env": { "WEFT_API_URL": "http://localhost:3000", "WEFT_TOKEN": "weft_..." }
    }
  }
}
```

For Claude Code: `claude mcp add weft -e WEFT_API_URL=http://localhost:3000 -e WEFT_TOKEN=weft_... -- bun /path/to/weft/apps/mcp/src/index.ts`.
