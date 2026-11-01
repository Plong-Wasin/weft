# MCP server

The MCP server lets an external AI client (Claude Code, Claude Desktop, Cursor, ...) use your workspace. It exposes every Action in the registry as a tool, except `delete_project`, `delete_workspace`, `create_workspace`, and token management. Tool schemas come from the Action input schemas.

- Auth: a personal API token. Create one while signed in (`create_api_token`), then pass it as `WEFT_TOKEN`. Revoking the token cuts the client off.
- Permissions: the token acts with its owner's permissions. Write actions run immediately with no Confirmation card; the client decides whether to ask you first.
- Workspace: tools that act inside a workspace take a `workspace` argument (the slug).
- Activity: changes are recorded with source `mcp`.

## Client setup

The server speaks stdio and calls the Weft API over HTTP.

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
