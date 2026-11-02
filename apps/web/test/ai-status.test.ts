import { expect, test } from "bun:test";
import { resources } from "@weft/shared";
import { requestAiStatus } from "../src/ai-status";

const reply = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status });

test("returns the status from the API", async () => {
  const status = { provider: "openai", model: "m", key: "present", configured: true } as const;
  expect(await requestAiStatus("w", reply(200, status))).toEqual(status);
});

test("returns null on failure or malformed answers", async () => {
  expect(await requestAiStatus("w", reply(403, { error: "no" }))).toBeNull();
  expect(await requestAiStatus("w", reply(200, { nope: 1 }))).toBeNull();
  expect(await requestAiStatus("w", async () => { throw new Error("offline"); })).toBeNull();
});

test("every AI status string exists in English and Thai", () => {
  const keys = Object.keys(resources.en).filter((key) => key.startsWith("aiStatus.") || key === "assist.notConfigured");
  expect(keys.length).toBeGreaterThan(5);
  for (const key of keys) expect((resources.th as Record<string, string>)[key]).toBeTruthy();
});
