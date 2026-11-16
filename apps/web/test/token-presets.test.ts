import { expect, test } from "bun:test";
import { defaultTokenPreset, presetExpiry, presetName } from "../src/token-presets";

test("the default preset is MCP with a 30-day expiry", () => {
  expect(defaultTokenPreset).toBe("mcp");
  expect(presetName("mcp")).toBe("MCP");
  expect(presetExpiry(new Date(2026, 10, 16))).toBe("2026-12-16");
});

test("the CLI preset fills its own name and the same 30-day expiry", () => {
  expect(presetName("cli")).toBe("CLI");
  expect(presetExpiry(new Date(2026, 0, 31))).toBe("2026-03-02");
});

test("the custom preset fills no name and leaves the expiry to the person", () => {
  expect(presetName("custom")).toBeNull();
});
