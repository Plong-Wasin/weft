import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createDatabase, outboundWebhooks, type Database } from "@weft/db";
import { withRollback } from "../../../packages/db/src/test-helpers";
import { createApp } from "../src/app";

const { client, db } = createDatabase();
afterAll(() => client.end());

// createApp(context, db, gates, aiModel, bus, aiOptions, passwordOptions, operations, mail, authOptions, features)
const appWithFlag = (tx: Database, outbound: boolean) => createApp(undefined, tx, undefined, undefined, undefined, undefined, undefined, undefined, null, undefined, { outboundWebhooks: outbound });

test.concurrent("with the flag off the config says so, the webhook Actions answer 404 and no webhook row is written", async () => {
  await withRollback(db, async (tx) => {
    const app = appWithFlag(tx, false);
    const config = await (await app.handle(new Request("http://localhost/api/config"))).json() as { outboundWebhooksEnabled: boolean };
    expect(config.outboundWebhooksEnabled).toBe(false);
    const signUp = await app.handle(new Request("http://localhost/api/auth/sign-up/email", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Ana", email: `${randomUUID()}@example.test`, password: "a-secure-password" }) }));
    const cookie = signUp.headers.get("set-cookie")!.split(";")[0]!;
    const call = (path: string, body: unknown) => app.handle(new Request(`http://localhost${path}`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) }));
    const workspace = await (await call("/actions/create_workspace", { name: "Team", slug: `t-${randomUUID()}` })).json() as { id: string };
    expect((await call("/actions/create_outbound_webhook", { workspaceId: workspace.id, name: "Hook", url: "https://93.184.216.34/hook", events: ["work_item.created"] })).status).toBe(404);
    expect((await call("/actions/list_outbound_webhooks", { workspaceId: workspace.id })).status).toBe(404);
    // No test send, delivery log or redelivery route either: nothing can reach the network through the API.
    expect((await call("/actions/test_outbound_webhook", { webhookId: randomUUID() })).status).toBe(404);
    expect((await call("/actions/list_outbound_webhook_deliveries", { webhookId: randomUUID() })).status).toBe(404);
    expect((await call("/actions/redeliver_outbound_webhook_delivery", { deliveryId: randomUUID() })).status).toBe(404);
    expect(await tx.select().from(outboundWebhooks)).toHaveLength(0);
  });
});

test.concurrent("with the flag on the config says so", async () => {
  await withRollback(db, async (tx) => {
    const config = await (await appWithFlag(tx, true).handle(new Request("http://localhost/api/config"))).json() as { outboundWebhooksEnabled: boolean };
    expect(config.outboundWebhooksEnabled).toBe(true);
  });
});
