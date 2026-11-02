import { createMcpHttpHandler } from "./server";

const handler = createMcpHttpHandler({
  apiUrl: Bun.env.WEFT_API_URL ?? "http://localhost:3000",
  publicUrl: Bun.env.WEFT_PUBLIC_URL ?? "http://localhost:8080",
});

const port = Number(Bun.env.PORT ?? 3001);
Bun.serve({ port, fetch: handler });
