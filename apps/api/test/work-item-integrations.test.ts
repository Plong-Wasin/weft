import { afterAll, expect, test } from "bun:test";
import { createHmac, randomUUID } from "node:crypto";
import { createDatabase, type Database } from "@weft/db";
import { withRollback } from "../../../packages/db/src/test-helpers";
import { createApp } from "../src/app";

const { client, db } = createDatabase();
afterAll(async () => client.end());

const hook = (integrationId: string, provider = "github") => `http://localhost/api/webhooks/work-items/${provider}/${integrationId}`;

test.concurrent("the webhook route checks the signature before doing anything and answers replays as ignored", async () => {
  await withRollback(db, async (tx: Database) => {
    const app = createApp(undefined, tx);
    const call = (path: string, body: unknown, cookie?: string) => app.handle(new Request(`http://localhost${path}`, {
      method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body),
    }));
    const signUp = async () => (await call("/api/auth/sign-up/email", { name: "Admin", email: `${randomUUID()}@example.test`, password: "a-secure-password" })).headers.get("set-cookie")!.split(";")[0]!;
    const admin = await signUp();
    const workspace = await (await call("/actions/create_workspace", { name: "Team", slug: `t-${randomUUID()}` }, admin)).json() as { id: string };
    const integration = await (await call("/actions/create_work_item_integration", { workspaceId: workspace.id, provider: "github" }, admin)).json() as { id: string; secret: string };
    expect((await call("/actions/update_work_item_integration", { integrationId: integration.id, enabled: true, repositories: ["acme/app"] }, admin)).status).toBe(200);

    const rawBody = JSON.stringify({ repository: { full_name: "acme/app" }, pull_request: { number: 11, title: "No key", body: "", html_url: "https://github.com/acme/app/pull/1", state: "open", merged: false, head: { ref: "x", sha: "s" } } });
    const signature = `sha256=${createHmac("sha256", integration.secret).update(rawBody).digest("hex")}`;
    const post = (headers: Record<string, string>, body = rawBody) => app.handle(new Request(hook(integration.id), { method: "POST", headers: { "content-type": "application/json", ...headers }, body }));

    const unsigned = await post({ "x-github-event": "pull_request", "x-github-delivery": "d-1" });
    expect(unsigned.status).toBe(401);
    expect(await unsigned.json()).toEqual({ error: "Invalid signature" });

    const delivery = { "x-github-event": "pull_request", "x-github-delivery": "d-2", "x-hub-signature-256": signature };
    const accepted = await post(delivery);
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({ result: "pull_request", linked: 0 });

    const replay = await post(delivery);
    expect(await replay.json()).toMatchObject({ result: "ignored", reason: "Delivery already received" });

    const missing = await app.handle(new Request(hook(randomUUID()), { method: "POST", headers: { "content-type": "application/json", "x-github-event": "pull_request" }, body: rawBody }));
    expect(missing.status).toBe(404);

    const tooLarge = await post({ "x-github-event": "pull_request", "x-hub-signature-256": signature }, "x".repeat(5 * 1024 * 1024 + 1));
    expect(tooLarge.status).toBe(413);
  });
});
