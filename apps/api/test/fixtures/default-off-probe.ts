// Runs in its own process with WEFT_INTEGRATIONS_ENABLED unset, and prints what the default-off app does.
import { createApp } from "../../src/app";

const app = createApp(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, null);
const config = await (await app.handle(new Request("http://localhost/api/config"))).json() as { integrationsEnabled: boolean };
const webhook = await app.handle(new Request("http://localhost/api/webhooks/work-items/github/00000000-0000-4000-8000-000000000000", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
const action = await app.handle(new Request("http://localhost/actions/create_work_item_integration", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
console.log(JSON.stringify({ flag: Bun.env.WEFT_INTEGRATIONS_ENABLED ?? null, integrationsEnabled: config.integrationsEnabled, webhook: webhook.status, action: action.status }));
process.exit(0);
