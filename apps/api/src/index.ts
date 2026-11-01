import { createApp } from "./app";

const port = Number(Bun.env.PORT ?? 3000);
const app = createApp().listen(port);
console.log(`Weft API listening on http://localhost:${app.server?.port}`);
