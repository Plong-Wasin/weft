import { afterAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { apiTokens, cliDevices, createDatabase, oauthAccessToken, oauthClient, oauthConsent, oauthRefreshToken } from "@weft/db";
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

test.concurrent("an enrolled CLI device renews its inactivity window on use, while an idle device expires after 90 days", async () => {
  await withRollback(db, async (transaction) => {
    const tokens = createApiTokenActions(transaction);
    const owner = await createUserFactory(transaction);
    const active = await tokens.createApiToken.handler({ userId: owner.id }, { name: "CLI @ active" });
    const idle = await tokens.createApiToken.handler({ userId: owner.id }, { name: "CLI @ idle" });
    const activeTokenHash = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(active.token))).toString("hex");
    const idleTokenHash = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(idle.token))).toString("hex");
    const [activeRow] = await transaction.select().from(apiTokens).where(eq(apiTokens.tokenHash, activeTokenHash));
    const [idleRow] = await transaction.select().from(apiTokens).where(eq(apiTokens.tokenHash, idleTokenHash));
    const now = new Date();
    await transaction.insert(cliDevices).values([
      { deviceId: crypto.randomUUID(), ownerId: owner.id, hostname: "active", tokenId: activeRow!.id, lastUsedAt: new Date(now.getTime() - 30 * 24 * 60 * 60_000) },
      { deviceId: crypto.randomUUID(), ownerId: owner.id, hostname: "idle", tokenId: idleRow!.id, lastUsedAt: new Date(now.getTime() - 91 * 24 * 60 * 60_000) },
    ]);
    await transaction.update(apiTokens).set({ expiresAt: new Date(now.getTime() + 24 * 60 * 60_000) }).where(eq(apiTokens.id, activeRow!.id));
    // An enrolled credential near its old expiry renews to a 90-day inactivity window on use.
    expect(await tokens.authenticateWithToken(active.token)).toEqual({ userId: owner.id, tokenId: activeRow!.id });
    const renewed = (await transaction.select().from(apiTokens).where(eq(apiTokens.id, activeRow!.id)))[0]!;
    const device = (await transaction.select().from(cliDevices).where(eq(cliDevices.tokenId, activeRow!.id)))[0]!;
    expect(renewed.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 89 * 24 * 60 * 60_000);
    expect(device.lastUsedAt.getTime()).toBeGreaterThan(now.getTime() - 1_000);
    // Once the device is beyond the inactivity window its credential is rejected, even if a row remains.
    await transaction.update(apiTokens).set({ expiresAt: new Date(now.getTime() - 91 * 24 * 60 * 60_000) }).where(eq(apiTokens.id, idleRow!.id));
    expect(await tokens.authenticateWithToken(idle.token)).toBeNull();
  });
});

test.concurrent("controlled device activity renews the 90-day window while legacy API tokens keep their original expiry", async () => {
  await withRollback(db, async (transaction) => {
    const owner = await createUserFactory(transaction);
    const enrolled = await createApiTokenActions(transaction).createApiToken.handler({ userId: owner.id }, { name: "Enrolled CLI" });
    const legacy = await createApiTokenActions(transaction).createApiToken.handler({ userId: owner.id }, { name: "Legacy CLI" });
    const hash = async (token: string) => Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))).toString("hex");
    const [enrolledRow] = await transaction.select().from(apiTokens).where(eq(apiTokens.tokenHash, await hash(enrolled.token)));
    const [legacyRow] = await transaction.select().from(apiTokens).where(eq(apiTokens.tokenHash, await hash(legacy.token)));
    const start = new Date("2026-01-01T00:00:00Z");
    await transaction.insert(cliDevices).values({ deviceId: crypto.randomUUID(), ownerId: owner.id, hostname: "active", tokenId: enrolledRow!.id, lastUsedAt: start });
    await transaction.update(apiTokens).set({ expiresAt: new Date(start.getTime() + 90 * 24 * 60 * 60_000) }).where(eq(apiTokens.id, enrolledRow!.id));
    await transaction.update(apiTokens).set({ expiresAt: new Date(start.getTime() + 90 * 24 * 60 * 60_000) }).where(eq(apiTokens.id, legacyRow!.id));
    let now = new Date(start);
    const tokens = createApiTokenActions(transaction, { now: () => new Date(now) });
    expect(await tokens.authenticateWithToken(enrolled.token)).toMatchObject({ userId: owner.id });
    now = new Date(start.getTime() + 89 * 24 * 60 * 60_000);
    expect(await tokens.authenticateWithToken(enrolled.token)).toMatchObject({ userId: owner.id });
    const renewed = (await transaction.select().from(apiTokens).where(eq(apiTokens.id, enrolledRow!.id)))[0]!;
    expect(renewed.expiresAt!.getTime()).toBe(start.getTime() + 179 * 24 * 60 * 60_000);
    now = new Date(start.getTime() + 180 * 24 * 60 * 60_000);
    expect(await tokens.authenticateWithToken(enrolled.token)).toBeNull();
    expect(await tokens.authenticateWithToken(legacy.token)).toBeNull();
    const unchangedLegacy = (await transaction.select().from(apiTokens).where(eq(apiTokens.id, legacyRow!.id)))[0]!;
    expect(unchangedLegacy.expiresAt!.getTime()).toBe(start.getTime() + 90 * 24 * 60 * 60_000);
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
