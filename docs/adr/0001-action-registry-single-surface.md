# Action Registry is the single surface for UI, AI, CLI, and MCP

Every operation on workspace data is defined once as an Action with a TypeBox schema and a permission check. The REST routes, AI tools, MCP tools, and CLI commands are all derived from that registry (`packages/actions`, which may not import from `apps/*`). Routes that are not CRUD (auth, SSE, upload) are written directly.

We rejected hand-written routes plus separate AI tool definitions because the two drift apart, and the AI would end up with weaker permission checks than the UI. The cost is that every new feature must be expressed as an Action first.

In the MVP the permission check lives inside each Action's handler, not in the registry's `permission` hook (which only guards the example Action). Because every surface derives from the same list, `packages/actions/test/registry-permissions.test.ts` calls every registered Action as a user with no membership and as a Guest and expects a 403 or 404. A new Action must pass it; list an Action as "own data only" in that test only when it never reads or writes anything shared.
