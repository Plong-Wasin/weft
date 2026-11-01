import { expect, test } from "bun:test";

// `bunx vite` runs under Node when Node is installed, and Node cannot load the workspace package's extensionless TypeScript
// imports. The config must load there, or `bun run dev:web` and the e2e dev server fail while everything under Bun still passes.
test.skipIf(!Bun.which("node"))("vite.config.ts loads under Node", async () => {
  const script = `import("vite").then((vite) => vite.loadConfigFromFile({ command: "build", mode: "production" }, "vite.config.ts", process.cwd())).then((result) => { if (!result) process.exit(2); console.log("loaded"); });`;
  const child = Bun.spawn(["node", "--input-type=module", "-e", script], { cwd: new URL("..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ code, out: out.trim(), err: err.split("\n")[0] }).toEqual({ code: 0, out: "loaded", err: "" });
}, 30_000);
