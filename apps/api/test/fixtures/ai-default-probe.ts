// Runs in its own process, so WEFT_AI_ENABLED and the provider key come from the parent's environment, and prints what the default app reports.
import { createApp } from "../../src/app";

const app = createApp(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, null);
const config = await (await app.handle(new Request("http://localhost/api/config"))).json() as { ai: { enabled: boolean; reason: string | null } };
const status = await app.handle(new Request("http://localhost/api/ai/status", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId: "00000000-0000-4000-8000-000000000000" }) }));
console.log(JSON.stringify({ flag: Bun.env.WEFT_AI_ENABLED ?? null, ai: config.ai, status: status.status }));
process.exit(0);
