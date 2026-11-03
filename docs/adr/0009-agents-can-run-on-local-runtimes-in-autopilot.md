# Agents can run on local Runtimes, and Autopilot applies writes without Confirmation

Supersedes the "no code execution and no local agent CLI" and "every write needs Confirmation" parts of ADR 0007, and the deferral of auto-approve in ADR 0002.

Teams want Agents that change code, not only Weft data, and want to use the agent CLIs and subscriptions they already have. Following Multica, a person runs a Daemon on their own computer; each agent CLI it finds becomes a Runtime in a workspace, private to its owner until shared. An admin binds an Agent to one shared Runtime, and that Agent's Runs execute there as an autonomous agent CLI that calls back into Weft through the `weft` CLI with a short-lived token bound to the Run and carrying the Originator's permissions. Server-side Agents from ADR 0007 stay.

Autopilot lets the AI apply Write actions without a Confirmation: a user picks it as a Chat mode, an admin turns it on for an Agent, and Agents on a Runtime always work in Autopilot, because what they do outside Weft (files, git) cannot be gated anyway. We accept the risk ADR 0002 and 0007 guarded against: instructions injected into work items, comments, or pages can now cause changes nobody reviewed first. Limits that remain: deletions still need a Confirmation, `delete_project` and `delete_workspace` are never exposed to the AI, Agent changes never fire triggers, and an Agent's comment never starts a Run. Isolation of a Runtime is its owner's responsibility; the only boundary is the OS user the Daemon runs as.

The Daemon talks to the server over one WebSocket that carries heartbeats and new-work signals, not HTTP long-polling: Weft is often deployed behind Cloudflare, whose proxy cuts idle HTTP requests at about 100 seconds, while a WebSocket with frequent heartbeats stays open.

Weft keeps no list of code repositories: each Run gets its own empty directory on the Daemon's computer, and the agent clones what its instructions name with that computer's git credentials. Unlike Multica we skip a shared bare-repo cache until per-Run clones prove too slow.
