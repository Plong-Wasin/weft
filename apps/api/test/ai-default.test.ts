import { expect, test } from "bun:test";

// The test runner turns WEFT_AI_ENABLED on, so the real default and the explicit off are checked in child processes with their own environment.
async function probe(env: Record<string, string | undefined>) {
  const child = Bun.spawn([process.execPath, new URL("./fixtures/ai-default-probe.ts", import.meta.url).pathname], { env, stdout: "pipe", stderr: "pipe" });
  const [out, , code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(code).toBe(0);
  return JSON.parse(out.trim().split("\n").at(-1)!) as { flag: string | null; ai: { enabled: boolean; reason: string | null }; status: number };
}

// The developer's own AI variables are removed, so each case states exactly what it sets.
const base = (extra: Record<string, string>): Record<string, string | undefined> => {
  const env: Record<string, string | undefined> = { ...Bun.env, ...extra };
  for (const name of ["WEFT_AI_ENABLED", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "AI_PROVIDER"]) if (!(name in extra)) delete env[name];
  return env;
};

test("with WEFT_AI_ENABLED unset and a provider key, AI is on by default and /api/ai answers", async () => {
  const result = await probe(base({ OPENAI_API_KEY: "sk-test" }));
  expect(result).toEqual({ flag: null, ai: { enabled: true, reason: null }, status: 401 });
});

test("with WEFT_AI_ENABLED=false AI is off whatever the key, and /api/ai answers 404", async () => {
  const result = await probe(base({ OPENAI_API_KEY: "sk-test", WEFT_AI_ENABLED: "false" }));
  expect(result).toEqual({ flag: "false", ai: { enabled: false, reason: "switched_off" }, status: 404 });
});

test("with WEFT_AI_ENABLED unset and no provider key, AI is off because of the missing key", async () => {
  const result = await probe(base({}));
  expect(result).toEqual({ flag: null, ai: { enabled: false, reason: "no_provider_key" }, status: 404 });
});
