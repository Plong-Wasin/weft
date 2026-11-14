import { expect, test } from "bun:test";

// The test runner turns the flag on for every test (scripts/test-isolated.ts), so the real default is checked in a child process with it unset.
test("with WEFT_INTEGRATIONS_ENABLED unset the integrations are off: config says so, the webhook answers 404 and the Actions are not registered", async () => {
  const env: Record<string, string | undefined> = { ...Bun.env };
  delete env.WEFT_INTEGRATIONS_ENABLED;
  const child = Bun.spawn([process.execPath, new URL("./fixtures/default-off-probe.ts", import.meta.url).pathname], { env, stdout: "pipe", stderr: "pipe" });
  const [out, , code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(code).toBe(0);
  expect(JSON.parse(out.trim().split("\n").at(-1)!)).toEqual({ flag: null, integrationsEnabled: false, webhook: 404, action: 404 });
});
