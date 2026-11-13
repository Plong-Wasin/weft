import { expect, test } from "bun:test";

/** Loads auth-client.ts in a fresh process: it reads VITE_API_URL once at import time, and a shared test process caches the module. */
async function loadAuthClient(viteApiUrl: string): Promise<{ code: number; out: string }> {
  const script = `globalThis.window = { location: { origin: "https://weft.example" } };
    try { await import("./src/auth-client.ts"); console.log("loaded"); } catch (e) { console.log(String(e)); process.exit(1); }`;
  const proc = Bun.spawn(["bun", "-e", script], { cwd: `${import.meta.dir}/..`, env: { ...process.env, VITE_API_URL: viteApiUrl }, stdout: "pipe", stderr: "pipe" });
  const out = (await new Response(proc.stdout).text()).trim();
  return { code: await proc.exited, out };
}

test("the web build for the single-origin proxy (empty VITE_API_URL) creates its auth client", async () => {
  expect(await loadAuthClient("")).toEqual({ code: 0, out: "loaded" });
});

test("the development build with a configured API URL creates its auth client", async () => {
  expect(await loadAuthClient("http://localhost:3000")).toEqual({ code: 0, out: "loaded" });
});
