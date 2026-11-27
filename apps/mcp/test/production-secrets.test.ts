import { expect, test } from "bun:test";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../../..");

function freePort() {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = probe.port!;
  probe.stop(true);
  return port;
}

async function whenListening(url: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    try { return await fetch(url); } catch { await Bun.sleep(50); }
  }
  throw new Error(`Nothing answered at ${url}`);
}

// The mcp service gets no S3 or auth secret (docker-compose.dokploy.yml), so the real entry point runs here with only its own settings.
test("the MCP service answers tools/list in production without S3_SECRET_KEY", async () => {
  const api = Bun.serve({ port: 0, fetch: () => Response.json({ workspaces: [] }) });
  const port = freePort();
  const mcp = Bun.spawn([process.execPath, "--no-env-file", "apps/mcp/src/http.ts"], {
    cwd: root,
    env: {
      PATH: process.env.PATH ?? "", NODE_ENV: "production", PORT: String(port),
      WEFT_API_URL: `http://localhost:${api.port}`, WEFT_PUBLIC_URL: "https://weft.example.test",
      // Every optional Action group is listed, so every Action factory is built.
      WEFT_INTEGRATIONS_ENABLED: "true", WEFT_OUTBOUND_WEBHOOKS_ENABLED: "true",
    },
    stdout: "ignore", stderr: "ignore",
  });
  try {
    const url = `http://localhost:${port}`;
    await whenListening(`${url}/.well-known/oauth-protected-resource`);
    const response = await fetch(`${url}/mcp`, {
      method: "POST",
      headers: { authorization: "Bearer weft_unused", "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(response.status).toBe(200);
    const body = await response.text();
    for (const name of ["duplicate_wiki_page", "request_asset_upload", "request_export", "create_work_item_integration", "create_outbound_webhook"]) expect(body).toContain(`"${name}"`);
  } finally {
    mcp.kill();
    await mcp.exited;
    api.stop(true);
  }
}, 30_000);
