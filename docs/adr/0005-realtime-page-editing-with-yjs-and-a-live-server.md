# Pages and Wiki pages are edited in realtime through Yjs and a separate live server

Several people must be able to edit one Page or Wiki page at the same time, as in Plane. We add a service `apps/live` (Hocuspocus over WebSocket) that authenticates with the existing Weft session and checks page access through the same Action layer as the API. The Yjs document state, stored as binary, is the source of truth for page content. On every save the service derives the Tiptap JSON `content` and the plain `contentText` from it, so search, versions, and the AI Sidecar keep reading the formats they read today. The 60-second edit lock is removed.

We rejected keeping the single-editor lock (simple, but it blocks concurrent editing, which is the goal) and CRDT state kept only in memory (loses edits on restart). The cost: a new long-running service, a migration of existing `content` into Yjs state, and AI writes that must be applied to the Yjs document instead of the row.

`apps/live` runs as one instance. Running several instances needs a shared pub/sub layer such as Redis; that is deferred until it is needed.
