import { expect, test } from "bun:test";
import { chosenCards } from "../src/proposal-selection";

const cards = (...ids: string[]) => ids.map((id) => ({ id }));

test("unticked cards are left out while several are pending", () => {
  expect(chosenCards(cards("a", "b", "c"), { b: true }).map((card) => card.id)).toEqual(["a", "c"]);
});

test("the last pending card stays decidable after it was unticked", () => {
  expect(chosenCards(cards("b"), { b: true }).map((card) => card.id)).toEqual(["b"]);
});
