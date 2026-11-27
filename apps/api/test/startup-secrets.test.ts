import { expect, test } from "bun:test";
import { resolve } from "node:path";

// The check runs before anything connects or listens, so this needs no database and no port.
test("the api service refuses to start in production without S3_SECRET_KEY", async () => {
  const service = Bun.spawn([process.execPath, "--no-env-file", "apps/api/src/index.ts"], {
    cwd: resolve(import.meta.dir, "../../.."),
    env: {
      PATH: process.env.PATH ?? "", NODE_ENV: "production", PORT: "0", LIVE_PORT: "0",
      DATABASE_URL: "postgres://weft:a-strong-test-password@127.0.0.1:1/weft", BETTER_AUTH_SECRET: "a-strong-test-value-of-at-least-32-characters",
    },
    stdout: "ignore", stderr: "pipe",
  });
  const timer = setTimeout(() => service.kill(), 20_000);
  const [code, errors] = await Promise.all([service.exited, new Response(service.stderr).text()]);
  clearTimeout(timer);
  expect(code).not.toBe(0);
  expect(errors).toContain("S3_SECRET_KEY is unset");
}, 30_000);
