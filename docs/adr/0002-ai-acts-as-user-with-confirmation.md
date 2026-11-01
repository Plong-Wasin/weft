# AI acts with the user's permissions and every Write action needs Confirmation

The AI chat calls the same Actions as the UI, with the permissions of the user it is talking to, and the Activity log records "user via AI" with the chat id. Read actions run immediately. Write actions are proposed as a Confirmation card showing the real input, expire after 24 hours, and are re-validated on confirm. `delete_project` and `delete_workspace` are never exposed to the AI or MCP.

We rejected a separate AI service account and auto-approve mode: work items, wiki pages, and comments are written by other people, so injected instructions in that data must not be able to cause changes without a human reading the exact action. Auto-approve is deferred to phase 2.
