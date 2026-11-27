import { join, sep } from "node:path";

const [, , directory, port, hostname] = process.argv;
if (!directory || !port) throw new Error("expected a web directory and port");

Bun.serve({
  port: Number(port),
  hostname: hostname ?? "127.0.0.1",
  async fetch(request) {
    if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405 });
    const pathname = decodeURIComponent(new URL(request.url).pathname);
    const path = join(directory, pathname === "/" ? "index.html" : pathname);
    if (path !== directory && !path.startsWith(directory + sep)) return new Response(null, { status: 404 });
    const requested = Bun.file(path);
    if (await requested.exists()) {
      const headers = pathname.startsWith("/assets/") ? { "cache-control": "public, max-age=31536000, immutable" } : undefined;
      return new Response(requested, { headers });
    }
    if (request.headers.get("accept")?.includes("text/html")) return new Response(Bun.file(join(directory, "index.html")));
    return new Response(null, { status: 404 });
  },
});
