import { afterAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { apiTokens, createDatabase } from "@weft/db";
import { createUserFactory, withRollback } from "../../db/src/test-helpers";
import { ActionError, createApiTokenActions } from "../src";

const { client, db } = createDatabase();
afterAll(async () => client.end());

test.concurrent("a token is shown once, stored only as a hash, and authenticates its owner", async () => {
  await withRollback(db, async (transaction) => {
    const tokens = createApiTokenActions(transaction);
    const owner = await createUserFactory(transaction);
    const created = await tokens.createApiToken.handler({ userId: owner.id }, { name: "laptop" });
    expect(created.token.startsWith("weft_")).toBe(true);
    const [row] = await transaction.select().from(apiTokens).where(eq(apiTokens.userId, owner.id));
    expect(JSON.stringify(row)).not.toContain(created.token);
    const listed = await tokens.listApiTokens.handler({ userId: owner.id }, {});
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(created.token);
    expect(listed[0]).toMatchObject({ id: created.id, name: "laptop", revokedAt: null });
    expect(await tokens.authenticate(created.token)).toEqual({ userId: owner.id });
    expect(await tokens.authenticate("weft_nope")).toBeNull();
  });
});

test.concurrent("a revoked token stops authenticating", async () => {
  await withRollback(db, async (transaction) => {
    const tokens = createApiTokenActions(transaction);
    const owner = await createUserFactory(transaction);
    const created = await tokens.createApiToken.handler({ userId: owner.id }, { name: "ci" });
    await tokens.revokeApiToken.handler({ userId: owner.id }, { tokenId: created.id });
    expect(await tokens.authenticate(created.token)).toBeNull();
    expect((await tokens.listApiTokens.handler({ userId: owner.id }, {}))[0]!.revokedAt).not.toBeNull();
  });
});

test.concurrent("another user can neither see nor revoke a token; tokens cannot manage tokens", async () => {
  await withRollback(db, async (transaction) => {
    const tokens = createApiTokenActions(transaction);
    const owner = await createUserFactory(transaction);
    const other = await createUserFactory(transaction);
    const created = await tokens.createApiToken.handler({ userId: owner.id }, { name: "mine" });
    expect(await tokens.listApiTokens.handler({ userId: other.id }, {})).toHaveLength(0);
    await expect(tokens.revokeApiToken.handler({ userId: other.id }, { tokenId: created.id })).rejects.toMatchObject({ status: 404 });
    expect(await tokens.authenticate(created.token)).toEqual({ userId: owner.id });
    await expect(tokens.createApiToken.handler({ userId: owner.id, via: "token" }, { name: "x" })).rejects.toBeInstanceOf(ActionError);
  });
});
