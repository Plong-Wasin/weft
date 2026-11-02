const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Top-level paths the proxy sends to a server instead of the web app. A browser navigation to one of them
 * (for example the OAuth authorize redirect) must reach the network, not the cached app shell.
 * A prefix matches the path itself and everything below it, never a longer sibling such as `/apiary`.
 */
export function navigationDenylist(bucket: string): RegExp[] {
  return ["api", "actions", "mcp", "live", "published", ".well-known", bucket]
    .filter((prefix) => prefix.length > 0)
    .map((prefix) => new RegExp(`^/${escape(prefix)}(?:[/?]|$)`));
}
