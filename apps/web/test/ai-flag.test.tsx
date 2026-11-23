import { expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { AiOnly, aiEnabledNow, aiStateNow, setAiEnabled, useAiOffReason } from "../src/ai-flag";

const render = () => renderToString(<AiOnly><span>ai surface</span></AiOnly>);

test("the AI state is unknown until /api/config answers, and AI surfaces render nothing meanwhile", () => {
  expect(aiStateNow()).toBe("unknown");
  expect(aiEnabledNow()).toBe(false);
  expect(render()).toBe("");
});

test("AI surfaces render only while the server reports AI on, and follow later changes", () => {
  setAiEnabled(true);
  expect(aiEnabledNow()).toBe(true);
  expect(aiStateNow()).toBe("on");
  expect(render()).toBe("<span>ai surface</span>");
  setAiEnabled(false);
  expect(aiEnabledNow()).toBe(false);
  expect(aiStateNow()).toBe("off");
  expect(render()).toBe("");
});

test("the reason AI is off is kept while it is off and cleared when it comes on", () => {
  const Reason = () => <span>{useAiOffReason() ?? "none"}</span>;
  setAiEnabled(false, "no_provider_key");
  expect(renderToString(<Reason />)).toBe("<span>no_provider_key</span>");
  setAiEnabled(false, "switched_off");
  expect(renderToString(<Reason />)).toBe("<span>switched_off</span>");
  setAiEnabled(true);
  expect(renderToString(<Reason />)).toBe("<span>none</span>");
});
