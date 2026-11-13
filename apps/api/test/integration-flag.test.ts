import { afterAll, expect, test } from "bun:test";
import { createHmac, randomUUID } from "node:crypto";
import { createDatabase, workItemIntegrations, type Database } from "@weft/db";
import { withRollback } from "../../../packages/db/src/test-helpers";
import { createApp } from "../src/app";

const { client, db } = createDatabase();
afterAll(async () => client.end());

// createApp(context, db, gates, aiModel, bus, aiOptions, passwordOptions, operations, mail, authOptions, features)
const appWithFlag = (tx: Database, integrations: boolean) => createApp(undefined, tx, undefined, undefined, undefined, undefined, undefined, undefined, null, undefined, { integrations });

test.concurrent("with the flag off the config says so, the webhook answers 404 and no integration row is written", async () => {
  await withRollback(db, async (tx) => {
    const app = appWithFlag(tx, false);
    const config = await (await app.handle(new Request("http://localhost/api/config"))).json() as { integrationsEnabled: boolean };
    expect(config.integrationsEnabled).toBe(false);
    const signUp = await app.handle(new Request("http://localhost/api/auth/sign-up/email", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Ana", email: `${randomUUID()}@example.test`, password: "a-secure-password" }) }));
    const cookie = signUp.headers.get("set-cookie")!.split(";")[0]!;
    const call = (path: string, body: unknown) => app.handle(new Request(`http://localhost${path}`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) }));
    const workspace = await (await call("/actions/create_workspace", { name: "Team", slug: `t-${randomUUID()}` })).json() as { id: string };
    // The Action is not registered, so the REST route does not exist.
    expect((await call("/actions/create_work_item_integration", { workspaceId: workspace.id, provider: "github" })).status).toBe(404);
    const body = JSON.stringify({ repository: { full_name: "acme/app" } });
    const hook = await app.handle(new Request(`http://localhost/api/webhooks/work-items/github/${randomUUID()}`, { method: "POST", headers: { "content-type": "application/json", "x-github-event": "pull_request", "x-hub-signature-256": `sha256=${createHmac("sha256", "x").update(body).digest("hex")}` }, body }));
    expect(hook.status).toBe(404);
    expect(await tx.select().from(workItemIntegrations)).toHaveLength(0);
  });
});

test.concurrent("with the flag on the config says so", async () => {
  await withRollback(db, async (tx) => {
    const config = await (await appWithFlag(tx, true).handle(new Request("http://localhost/api/config"))).json() as { integrationsEnabled: boolean };
    expect(config.integrationsEnabled).toBe(true);
  });
});
