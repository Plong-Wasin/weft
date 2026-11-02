# Weft is its own OAuth authorization server for HTTP MCP

The MCP server gains a Streamable HTTP transport (stateless, one MCP server per request) next to stdio. `/mcp` accepts a single `Authorization: Bearer` credential, either a Personal API token (`weft_` prefix) or an OAuth access token, and forwards it unchanged to the API, so permissions and Activity stay in the Actions. Without a credential it answers `401` with a `WWW-Authenticate` header pointing at protected-resource metadata, so clients start OAuth on their own.

Weft itself is the authorization server, built on Better Auth, which already owns users and sessions: Dynamic Client Registration (public clients only), PKCE S256 required, a consent screen in the web app, access tokens of 1 hour, rotating refresh tokens of 30 days. A grant covers the whole user (all workspaces) with no scopes, exactly like a Personal API token; roles are still checked per Action. Tokens (personal or OAuth) can never manage tokens or grants: that needs a signed-in session.

We rejected an external identity provider (extra service to run, and a second user store to keep in step) and per-workspace or per-scope grants (the Action permission checks already bound what a user can do; scopes would be a second permission model). Plane was the reference for the token page only: it has no MCP and no OAuth provider.
