import { expect, test } from "bun:test";
import { navigationDenylist } from "../src/navigation-denylist";

const denied = (path: string, bucket = "weft-assets") => navigationDenylist(bucket).some((pattern) => pattern.test(path));

test("server-owned prefixes are never answered by the cached app shell", () => {
  for (const path of ["/api/auth/oauth2/authorize", "/api/events", "/actions/hello", "/mcp", "/mcp/sse", "/live/ws", "/published/token", "/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource/mcp", "/weft-assets/x.png", "/mcp?x=1"]) {
    expect(denied(path)).toBe(true);
  }
});

test("app routes and look-alike paths still reach the app shell", () => {
  for (const path of ["/", "/acme/projects", "/apiary/issues", "/mcpx", "/livestock", "/weft-assets-docs", "/acme/api"]) {
    expect(denied(path)).toBe(false);
  }
});

test("the bucket prefix follows the configured bucket name", () => {
  expect(denied("/files/a.png", "files")).toBe(true);
  expect(denied("/weft-assets/a.png", "files")).toBe(false);
});

test("a bucket name with regex characters is matched literally", () => {
  expect(denied("/a.b/x", "a.b")).toBe(true);
  expect(denied("/axb/x", "a.b")).toBe(false);
});
