import { expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { AiOnly, aiEnabledNow, aiStateNow, setAiEnabled } from "../src/ai-flag";

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
