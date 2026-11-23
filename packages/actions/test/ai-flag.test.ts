import { expect, test } from "bun:test";
import { aiEnabled, aiState } from "../src";

const key = { OPENAI_API_KEY: "sk-test" };

test("AI is on by default when the provider key is set: only the exact value false switches it off", () => {
  expect(aiState({ ...key })).toEqual({ enabled: true, reason: null });
  expect(aiState({ ...key, WEFT_AI_ENABLED: "true" })).toEqual({ enabled: true, reason: null });
  for (const value of ["", "0", "no", "FALSE", "False", " false"]) {
    expect(aiState({ ...key, WEFT_AI_ENABLED: value })).toEqual({ enabled: true, reason: null });
  }
  expect(aiEnabled({ ...key })).toBe(true);
});

test("the variable set to false reports the switch as the cause", () => {
  expect(aiState({ ...key, WEFT_AI_ENABLED: "false" })).toEqual({ enabled: false, reason: "switched_off" });
  expect(aiState({ WEFT_AI_ENABLED: "false" })).toEqual({ enabled: false, reason: "switched_off" });
  expect(aiEnabled({ ...key, WEFT_AI_ENABLED: "false" })).toBe(false);
});

test("AI counts as off without a provider key, and says so distinctly", () => {
  expect(aiState({})).toEqual({ enabled: false, reason: "no_provider_key" });
  expect(aiState({ OPENAI_API_KEY: "   " })).toEqual({ enabled: false, reason: "no_provider_key" });
  expect(aiState({ OPENAI_API_KEY: "sk-test", AI_PROVIDER: "anthropic" })).toEqual({ enabled: false, reason: "no_provider_key" });
  expect(aiState({ AI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-ant" })).toEqual({ enabled: true, reason: null });
  expect(aiState({ AI_PROVIDER: "other", OPENAI_API_KEY: "sk-test" })).toEqual({ enabled: false, reason: "no_provider_key" });
});

test("a switched-off server reports switched_off even when it also lacks a key", () => {
  expect(aiState({ WEFT_AI_ENABLED: "false" }).reason).toBe("switched_off");
});
