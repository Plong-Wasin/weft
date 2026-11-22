import { expect, test } from "bun:test";
import { handleImeSafeEnter } from "../src/ime";

function keyboardEvent({ key = "Enter", isComposing = false, keyCode = 13 }: Partial<{ key: string; isComposing: boolean; keyCode: number }> = {}) {
  let prevented = false;
  let actions = 0;
  const handled = handleImeSafeEnter({ key, isComposing, keyCode, preventDefault: () => { prevented = true; } }, () => { actions += 1; });
  return { handled, prevented, actions };
}

test("normal Enter prevents its default and performs the action once", () => {
  expect(keyboardEvent()).toEqual({ handled: true, prevented: true, actions: 1 });
});

test("composing Enter keeps the browser's IME confirmation behavior", () => {
  expect(keyboardEvent({ isComposing: true })).toEqual({ handled: false, prevented: false, actions: 0 });
});

test("Safari's keyCode 229 fallback keeps IME confirmation behavior", () => {
  expect(keyboardEvent({ keyCode: 229 })).toEqual({ handled: false, prevented: false, actions: 0 });
});

test("other keys leave the native behavior alone", () => {
  expect(keyboardEvent({ key: "Escape" })).toEqual({ handled: false, prevented: false, actions: 0 });
});
