# AI web search uses the model provider's own tool and is opt-in per chat

The AI chat may look up the public web, but only through the web search tool of the configured model provider (OpenAI or Anthropic), only when the user switches Web search on for that chat, and only when the server has not disabled it with `AI_WEB_SEARCH=off`. It is off by default, works in Ask and Build mode, and shows the sources it used. Before this, the AI could call no external service at all.

We rejected a third-party search API (Tavily, Brave and similar): it adds a key, a dependency and a second place where workspace questions leave the system. We rejected a workspace-wide admin setting for now: the per-chat switch plus the server flag cover the need, and an admin setting can be added later.

Web pages are untrusted input, so a page can try to steer the AI into proposing a Write action. The Confirmation card from ADR 0002 stays the only defence, and the system prompt tells the model that web content is data, not instructions. Agent Runs (ADR 0007) do not get Web search, because nobody watches them live.
