import { s3SettingsFromEnv, warmWrittenFormPool } from "@weft/actions";
import { createApp } from "./app";
import { startupWarnings } from "./startup-warnings";

for (const warning of startupWarnings(Bun.env)) console.warn(warning);
// Throws in production while S3_SECRET_KEY is missing or a default; Actions build their storage only on first use.
s3SettingsFromEnv();
const port = Number(Bun.env.PORT ?? 3000);
const app = createApp().listen(port);
console.log(`Weft API listening on http://localhost:${app.server?.port}`);
void warmWrittenFormPool();
