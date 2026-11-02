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
| Cycles | `list_cycles`, `get_cycle`, `check_cycle_dates` | `create_cycle`, `update_cycle`, `add_cycle_items`, `remove_cycle_items`, `transfer_cycle_items`, `archive_cycle`, `unarchive_cycle`, `delete_cycle` |
| Modules | `list_modules`, `get_module` | `create_module`, `update_module`, `add_module_items`, `remove_module_items`, `archive_module`, `unarchive_module`, `delete_module` |
| Work item archive | `list_work_items` with `archived: true` | `archive_work_item`, `restore_work_item` (project Admin or Member; a completed or cancelled work item only) |
| Estimates | `get_estimate`, `get_estimate_usage` | `create_estimate`, `update_estimate`, `delete_estimate_point`, `switch_estimate_type`, `delete_estimate` (project Admin) |
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

- Fields: `title`, `text`, `id`, `state`, `stateGroup`, `priority`, `estimate`, `assignee`, `label`, `cycle`, `module`, `mention`, `createdBy`, `project`, `startDate`, `dueDate`, `createdAt`, `updatedAt`.
- Operators: `=`, `!=`, `~`, `IN`, `NOT IN`, `<`, `<=`, `>`, `>=`, `BETWEEN a AND b`, `IS NULL`, `IS NOT NULL`.
- Functions: `currentUser()`, `today()`, `startOfWeek()`, `endOfWeek()`, `activeCycle()`, `openStates()`, `closedStates()`, `isOverdue()`, `hasNoAssignee()`, `hasNoLabel()`.
- `estimate` is the Estimate point value of the project's active Estimate. Points compare as numbers (`=`, `!=`, `<`, `<=`, `>`, `>=`, `BETWEEN`, `IN`, `NOT IN`); categories use `=`, `!=`, `IN`, `NOT IN` and match case-insensitively. `IS NULL` finds unsized work items. A value that is not on the scale is an error that lists the scale, and a project with no active Estimate refuses the field.
- State, label, assignee, Cycle, and Module are written by name and resolved inside the project. An error names the character position and the reason.

```text
priority IN (urgent, high) AND assignee = currentUser() AND dueDate < today() ORDER BY dueDate LIMIT 20
cycle = activeCycle() AND stateGroup != completed AND hasNoAssignee()
module = "Mobile app" AND label = bug AND cycle IS NULL ORDER BY priority DESC
estimate >= 8 AND stateGroup IN (openStates()) ORDER BY estimate DESC
```

## Client setup

The MCP server supports stdio and Streamable HTTP. Both use the same tools and call the Weft API.

### HTTP

Compose starts the `mcp` service on `MCP_PORT` (3001) but does not include a reverse proxy; put one in front that gives the HTTP endpoint at `https://<weft>/mcp` on a single origin. Set `WEFT_PUBLIC_URL` to that public origin (for example, `https://weft.example`) for the `api` and `mcp` services. Route `/mcp` and `/.well-known/oauth-protected-resource*` to the MCP service; route `/api` and `/.well-known/oauth-authorization-server*` to the API; route `/oauth/*` and everything else to the web app. Set `TRUSTED_PROXY_HOPS` to the number of proxies in front of the API so anonymous client registration is rate limited per caller (default 0: one shared bucket, 20 per hour per caller and 200 per hour overall). Keep these paths on the same origin so the OAuth issuer, discovery URLs, and consent redirects agree.

A client that supports OAuth can discover the protected-resource document at `https://<weft>/.well-known/oauth-protected-resource`. It identifies `https://<weft>/mcp` as the resource and `https://<weft>/api/auth` as the authorization server. The MCP endpoint returns `401` with a `WWW-Authenticate: Bearer resource_metadata="https://<weft>/.well-known/oauth-protected-resource"` challenge when credentials are missing, expired, or revoked; the client can use that metadata to register, sign in, and request consent. OAuth clients use Dynamic Client Registration and PKCE S256; access tokens last one hour and refresh tokens rotate for 30 days. Personal API tokens remain supported as Bearer credentials for clients without OAuth. Requests are stateless, and the API validates credentials on every request.

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
