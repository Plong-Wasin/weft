import { afterAll, expect, test } from "bun:test";
import { createDatabase } from "@weft/db";
import { createLocaleActions } from "../src";
import { createUserFactory, withRollback } from "../../db/src/test-helpers";

const { client, db } = createDatabase();
afterAll(async () => client.end());

test.concurrent("a new user defaults to English and the chosen language persists per user", async () => {
  await withRollback(db, async (transaction) => {
    const actions = createLocaleActions(transaction);
    const [alice, bob] = [await createUserFactory(transaction), await createUserFactory(transaction)];
    expect(await actions.getMyLocale.handler({ userId: alice.id }, {})).toEqual({ locale: "en" });
    expect(await actions.setMyLocale.handler({ userId: alice.id }, { locale: "th" })).toEqual({ locale: "th" });
    expect(await actions.getMyLocale.handler({ userId: alice.id }, {})).toEqual({ locale: "th" });
    expect(await actions.getMyLocale.handler({ userId: bob.id }, {})).toEqual({ locale: "en" });
  });
});

test.concurrent("an unsupported language is rejected by the schema", async () => {
  const { Value } = await import("@sinclair/typebox/value");
  const actions = createLocaleActions(db);
  expect(Value.Check(actions.setMyLocale.input, { locale: "fr" })).toBe(false);
  expect(Value.Check(actions.setMyLocale.input, { locale: "th" })).toBe(true);
});
