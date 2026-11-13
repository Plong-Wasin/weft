import { expect, test } from "bun:test";
import { resources } from "@weft/shared";

test("every Runtime settings string has an English and Thai translation", () => {
  const keys = Object.keys(resources.en).filter((key) => key.startsWith("runtimes."));
  expect(keys.length).toBeGreaterThan(8);
  for (const key of keys) expect((resources.th as Record<string, string>)[key], `${key} is missing in Thai`).toBeTruthy();
});

test("profile labels and full-access warnings are available to settings, Agent pickers and Run transcripts", () => {
  for (const key of ["runtimes.profileHelp", "runtimes.fullAccessWarning", "runtimes.sandboxEnabled", "agents.runtimeProfile", "agents.runtimeProfileHelp", "runs.runtimeProfileHeader"]) {
    expect(resources.en[key as keyof typeof resources.en]).toBeTruthy();
    expect((resources.th as Record<string, string>)[key]).toBeTruthy();
  }
});

test("deleting a profile asks first, and editing one offers Cancel", async () => {
  const source = (await import("node:fs")).readFileSync(new URL("../src/pages/settings/runtimes-settings.tsx", import.meta.url), "utf8");
  expect(source.indexOf("runtimes.deleteProfileConfirm")).toBeGreaterThan(-1);
  expect(source.indexOf("runtimes.deleteProfileConfirm")).toBeLessThan(source.indexOf('"delete_runtime_profile"'));
  expect(source).toMatch(/editingId && <button[\s\S]{0,300}translate\("comments\.cancel"\)/);
  expect(resources.en["runtimes.deleteProfileConfirm"]).toContain("{name}");
});
