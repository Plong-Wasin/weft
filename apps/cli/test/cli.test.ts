import { afterAll, expect, test } from "bun:test";
import { createDatabase } from "@weft/db";
import { withRollback } from "../../../packages/db/src/test-helpers";
import { createApp } from "../../api/src/app";
import { main } from "../src/program";

const { client, db } = createDatabase();
afterAll(async () => client.end());

async function run(app: ReturnType<typeof createApp>, args: string[], token?: string) {
  const out: string[] = [];
  const err: string[] = [];
  const failed = (await main(["node", "weft", ...args], {
    fetch: (input, init) => app.handle(new Request(input as string, init)),
    env: { WEFT_API_URL: "http://localhost", ...(token ? { WEFT_TOKEN: token } : {}) },
    stdout: (text) => out.push(text), stderr: (text) => err.push(text),
  })) !== 0;
  return { out: out.join(""), err: err.join(""), failed };
}

test.concurrent("CLI commands derived from the registry read and change a workspace chosen by slug, as source cli", async () => {
  await withRollback(db, async (transaction) => {
    const app = createApp(undefined, transaction);
    const call = (path: string, body: unknown, cookie?: string) => app.handle(new Request(`http://localhost${path}`, {
      method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body),
    }));
    const signUp = await call("/api/auth/sign-up/email", { name: "Dev", email: `${crypto.randomUUID()}@example.test`, password: "a-secure-password" });
    const cookie = signUp.headers.get("set-cookie")!.split(";")[0]!;
    const slug = `cli-${crypto.randomUUID().slice(0, 8)}`;
    await call("/actions/create_workspace", { name: "Team", slug }, cookie);
    const { token } = await (await call("/actions/create_api_token", { name: "cli" }, cookie)).json() as { token: string };

    const created = await run(app, ["create-project", "--workspace", slug, "--name", "Mobile", "--key", "MOB", "--visibility", "public"], token);
    expect(created.failed).toBe(false);
    const project = JSON.parse(created.out) as { id: string };
    const item = JSON.parse((await run(app, ["create-work-item", "--project-id", project.id, "--title", "Ship it"], token)).out) as { id: string };
    const listed = JSON.parse((await run(app, ["list-projects", "--workspace", slug], token)).out) as Array<{ key: string }>;
    expect(listed.map((row) => row.key)).toContain("MOB");
    const log = await (await call("/actions/list_work_item_activities", { workItemId: item.id }, cookie)).json() as Array<{ source: string }>;
    expect(log.length).toBeGreaterThan(0);
    expect(log.every((row) => row.source === "cli")).toBe(true);

    expect((await run(app, ["list-projects", "--workspace", "nope"], token)).failed).toBe(true);
    expect((await run(app, ["list-projects"], token)).err).toContain("--workspace");
    expect((await run(app, ["list-projects", "--workspace", slug])).err).toContain("token");
    expect((await run(app, ["list-projects", "--workspace", slug], "weft_bogus")).failed).toBe(true);
  });
});

test.concurrent("a revoked token is refused by the CLI", async () => {
  await withRollback(db, async (transaction) => {
    const app = createApp(undefined, transaction);
    const call = (path: string, body: unknown, cookie?: string) => app.handle(new Request(`http://localhost${path}`, {
      method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body),
    }));
    const signUp = await call("/api/auth/sign-up/email", { name: "Dev", email: `${crypto.randomUUID()}@example.test`, password: "a-secure-password" });
    const cookie = signUp.headers.get("set-cookie")!.split(";")[0]!;
    const slug = `cli-${crypto.randomUUID().slice(0, 8)}`;
    await call("/actions/create_workspace", { name: "Team", slug }, cookie);
    const { id, token } = await (await call("/actions/create_api_token", { name: "cli" }, cookie)).json() as { id: string; token: string };
    expect((await run(app, ["list-projects", "--workspace", slug], token)).failed).toBe(false);
    await call("/actions/revoke_api_token", { tokenId: id }, cookie);
    const denied = await run(app, ["list-projects", "--workspace", slug], token);
    expect(denied.failed).toBe(true);
    expect(denied.err).toContain("Unauthenticated");
  });
});
