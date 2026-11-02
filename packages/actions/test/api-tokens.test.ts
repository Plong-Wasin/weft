import { afterAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { apiTokens, createDatabase, oauthAccessToken, oauthClient, oauthConsent, oauthRefreshToken } from "@weft/db";
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

test.concurrent("authorized apps are session-only and revoking one invalidates only its tokens", async () => {
  await withRollback(db, async (transaction) => {
    const actions = createApiTokenActions(transaction);
    const owner = await createUserFactory(transaction);
    const clientIds = [crypto.randomUUID(), crypto.randomUUID()];
    for (const [index, clientId] of clientIds.entries()) {
      await transaction.insert(oauthClient).values({ id: clientId, clientId, name: `App ${index}`, redirectUris: [], createdAt: new Date() });
      await transaction.insert(oauthConsent).values({ id: crypto.randomUUID(), clientId, userId: owner.id, scopes: [], createdAt: new Date(), updatedAt: new Date() });
      await transaction.insert(oauthAccessToken).values({ id: crypto.randomUUID(), clientId, userId: owner.id, token: `${index}`, expiresAt: new Date(Date.now() + 60_000), createdAt: new Date(), scopes: [] });
      await transaction.insert(oauthRefreshToken).values({ id: crypto.randomUUID(), clientId, userId: owner.id, token: `refresh-${index}`, expiresAt: new Date(Date.now() + 60_000), createdAt: new Date(), scopes: [] });
    }
    expect(await actions.listAuthorizedApps.handler({ userId: owner.id }, {})).toHaveLength(2);
    for (const via of ["token", "oauth"] as const) {
      await expect(actions.listAuthorizedApps.handler({ userId: owner.id, via }, {})).rejects.toMatchObject({ status: 403 });
      await expect(actions.revokeAuthorizedApp.handler({ userId: owner.id, via }, { clientId: clientIds[0]! })).rejects.toMatchObject({ status: 403 });
    }
    await actions.revokeAuthorizedApp.handler({ userId: owner.id }, { clientId: clientIds[0]! });
    expect(await actions.listAuthorizedApps.handler({ userId: owner.id }, {})).toHaveLength(1);
    const access = await transaction.select().from(oauthAccessToken).orderBy(oauthAccessToken.clientId);
    const refresh = await transaction.select().from(oauthRefreshToken).orderBy(oauthRefreshToken.clientId);
    expect(access.map((row) => [row.clientId, row.revoked !== null])).toEqual(expect.arrayContaining([[clientIds[0], true], [clientIds[1], false]]));
    expect(refresh.map((row) => [row.clientId, row.revoked !== null])).toEqual(expect.arrayContaining([[clientIds[0], true], [clientIds[1], false]]));
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
