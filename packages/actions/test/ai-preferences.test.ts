import { afterAll, expect, test } from "bun:test";
import { createDatabase } from "@weft/db";
import { createAiPreferenceActions } from "../src";
import { createUserFactory, withRollback } from "../../db/src/test-helpers";

const { client, db } = createDatabase();
afterAll(async () => client.end());

test.concurrent("the AI selection menu is shown by default and the choice persists per person", async () => {
  await withRollback(db, async (transaction) => {
    const actions = createAiPreferenceActions(transaction);
    const [alice, bob] = [await createUserFactory(transaction), await createUserFactory(transaction)];
    expect(await actions.getMyAiPreferences.handler({ userId: alice.id }, {})).toEqual({ showSelectionMenu: true });
    expect(await actions.setMyAiPreferences.handler({ userId: alice.id }, { showSelectionMenu: false })).toEqual({ showSelectionMenu: false });
    expect(await actions.getMyAiPreferences.handler({ userId: alice.id }, {})).toEqual({ showSelectionMenu: false });
    expect(await actions.getMyAiPreferences.handler({ userId: bob.id }, {})).toEqual({ showSelectionMenu: true });
    expect(await actions.setMyAiPreferences.handler({ userId: alice.id }, { showSelectionMenu: true })).toEqual({ showSelectionMenu: true });
    expect(await actions.getMyAiPreferences.handler({ userId: alice.id }, {})).toEqual({ showSelectionMenu: true });
  });
});

test.concurrent("the preference accepts only a boolean", async () => {
  const { Value } = await import("@sinclair/typebox/value");
  const actions = createAiPreferenceActions(db);
  expect(Value.Check(actions.setMyAiPreferences.input, { showSelectionMenu: false })).toBe(true);
  expect(Value.Check(actions.setMyAiPreferences.input, { showSelectionMenu: "off" })).toBe(false);
  expect(Value.Check(actions.setMyAiPreferences.input, {})).toBe(false);
});
