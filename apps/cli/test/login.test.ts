import { afterAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "@weft/db";
import { withRollback } from "../../../packages/db/src/test-helpers";
import { createApp } from "../../api/src/app";
import { login } from "../src/daemon";
import { main } from "../src/program";

const { client, db } = createDatabase();
afterAll(async () => client.end());

test.concurrent("weft login saves a normal personal token; the Daemon credential comes from registration and is refused on /actions", async () => {
  await withRollback(db, async (transaction) => {
    const app = createApp(undefined, transaction);
    const signUp = await app.handle(new Request("http://localhost/api/auth/sign-up/email", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Dev", email: `${crypto.randomUUID()}@example.test`, password: "a-secure-password" }),
    }));
    const cookie = signUp.headers.get("set-cookie")!.split(";")[0]!;
    const slug = `login-${crypto.randomUUID().slice(0, 8)}`;
    await app.handle(new Request("http://localhost/actions/create_workspace", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ name: "Team", slug }) }));

    const home = await mkdtemp(join(tmpdir(), "weft-login-test-"));
    try {
      const apiFetch = async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
        return app.handle(new Request(`http://localhost${url.pathname}${url.search}`, init));
      };
      // The approval happens in a separately authenticated browser session; the terminal receives only the exchange result.
      await login({
        env: { WEFT_API_URL: "http://localhost", XDG_CONFIG_HOME: home },
        fetch: apiFetch, sleep: async () => {}, stdout: () => {},
        openBrowser: async (url: string) => {
          const code = new URL(url).searchParams.get("code")!;
          const review = await app.handle(new Request(`http://localhost/api/cli/device-authorization?code=${code}`, { headers: { cookie } }));
          expect(review.status).toBe(200);
          const decision = await app.handle(new Request("http://localhost/api/cli/device-authorization/decision", { method: "POST", headers: { cookie, origin: "http://localhost:5173", "content-type": "application/json" }, body: JSON.stringify({ code, decision: "approve" }) }));
          expect(decision.status).toBe(200);
        },
      });
      const config = JSON.parse(await readFile(join(home, "weft", "config.json"), "utf8")) as { token: string; deviceId: string; daemonToken?: string };
      expect(config.token).toStartWith("weft_");
      expect(config.deviceId).toMatch(/^[0-9a-f-]{36}$/i);
      expect(config.token.startsWith("weft_daemon_")).toBe(false);
      expect(config.daemonToken).toBeUndefined();
      // The Daemon credential is issued by registration, with the CLI token, and is stored in its own file.
      const registered = await app.handle(new Request("http://localhost/api/daemon/register", {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${config.token}` }, body: JSON.stringify({ hostname: "devbox", version: "1", agentClis: [] }),
      }));
      const daemonToken = (await registered.json() as { daemonToken: string }).daemonToken;
      expect(daemonToken).toStartWith("weft_daemon_");

      const listed: string[] = [];
      const failed = (await main(["node", "weft", "-w", slug, "list-projects"], {
        env: { XDG_CONFIG_HOME: home, WEFT_API_URL: "http://localhost" },
        fetch: (input, init) => app.handle(new Request(input as string, init)),
        stdout: (text) => listed.push(text), stderr: (text) => listed.push(text),
      })) !== 0;
      expect(failed).toBe(false);
      expect(listed.join("")).toContain("[");

      const refused = await app.handle(new Request("http://localhost/actions/list_projects", {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${daemonToken}` }, body: JSON.stringify({ workspaceId: crypto.randomUUID() }),
      }));
      expect(refused.status).toBe(401);

      const expired: string[] = [];
      const expiredFailed = (await main(["node", "weft", "-w", slug, "list-projects"], {
        env: { XDG_CONFIG_HOME: join(home, "none"), WEFT_API_URL: "http://localhost", WEFT_TOKEN: "weft_expired_token" },
        fetch: (input, init) => app.handle(new Request(input as string, init)),
        stdout: () => {}, stderr: (text) => expired.push(text),
      })) !== 0;
      expect(expiredFailed).toBe(true);
      expect(expired.join("")).toContain("run `weft login` again");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
