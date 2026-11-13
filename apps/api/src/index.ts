import { createApp } from "./app";
import { startupWarnings } from "./startup-warnings";

for (const warning of startupWarnings(Bun.env)) console.warn(warning);
const port = Number(Bun.env.PORT ?? 3000);
const app = createApp().listen(port);
console.log(`Weft API listening on http://localhost:${app.server?.port}`);
