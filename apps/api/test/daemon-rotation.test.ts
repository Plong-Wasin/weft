import { afterAll, expect, test } from "bun:test";
import { and, eq, gt, isNull } from "drizzle-orm";
import { apiTokens, createDatabase, daemons, users, type Database } from "@weft/db";
import { mintApiToken } from "@weft/actions";
import { createUserFactory, withRollback } from "../../../packages/db/src/test-helpers";
import { createApp } from "../src/app";

const { client, db } = createDatabase();
afterAll(async () => client.end());

const GRACE_MS = 10 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function setup(transaction: Database) {
  const app = createApp(undefined, transaction);
  const call = (path: string, body: unknown, bearer?: string) => app.handle(new Request(`http://localhost${path}`, {
    method: "POST", headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, body: JSON.stringify(body),
  }));
  const register = (token: string, body: Record<string, unknown> = {}) => call("/api/daemon/register", { hostname: "devbox", version: "1", agentClis: ["claude"], ...body }, token);
  const claim = (token: string) => call("/api/daemon/runs/claim", {}, token);
  return { app, call, register, claim };
}

async function sha256Hex(value: string) {
  return Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))).toString("hex");
}

/** The api_tokens row of a plain token, found by its hash. */
async function rowOf(database: Database, token: string) {
  const [row] = await database.select().from(apiTokens).where(eq(apiTokens.tokenHash, await sha256Hex(token)));
  return row!;
}

async function personalTokenFor(database: Database) {
  const user = await createUserFactory(database);
  const personal = await mintApiToken(database, { userId: user.id, name: "cli", description: null, expiresAt: new Date(Date.now() + 30 * DAY_MS) });
  return { userId: user.id, personal: personal.token };
}

// These two tests commit rows, so they run outside withRollback: concurrent calls need their own connections to race for the lock.
test("concurrent first registrations for one owner and hostname make one Daemon row and one active Daemon token", async () => {
  const user = await createUserFactory(db);
  try {
    const personal = await mintApiToken(db, { userId: user.id, name: "cli", description: null, expiresAt: new Date(Date.now() + 30 * DAY_MS) });
    const { register } = setup(db);
    const responses = await Promise.all([register(personal.token), register(personal.token), register(personal.token)]);
    const bodies = await Promise.all(responses.map((response) => response.json() as Promise<{ daemonId: string; daemonToken?: string }>));
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
    expect(new Set(bodies.map((body) => body.daemonId)).size).toBe(1);
    expect(bodies.filter((body) => body.daemonToken).length).toBe(1);
    const rows = await db.select().from(daemons).where(and(eq(daemons.ownerId, user.id), eq(daemons.hostname, "devbox")));
    expect(rows).toHaveLength(1);
    const active = await db.select({ id: apiTokens.id }).from(apiTokens).where(and(eq(apiTokens.userId, user.id), eq(apiTokens.daemonOnly, true), isNull(apiTokens.revokedAt), gt(apiTokens.expiresAt, new Date())));
    expect(active).toHaveLength(1);
    expect(active[0]!.id).toBe(rows[0]!.tokenId);
  } finally {
    await db.delete(users).where(eq(users.id, user.id));
  }
});

test("concurrent rotations for one owner and hostname leave one Daemon row whose token is active and older tokens inside their grace", async () => {
  const user = await createUserFactory(db);
  try {
    const personal = await mintApiToken(db, { userId: user.id, name: "cli", description: null, expiresAt: new Date(Date.now() + 30 * DAY_MS) });
    const { register } = setup(db);
    await register(personal.token);
    const responses = await Promise.all([1, 2, 3].map(() => register(personal.token, { rotate: true })));
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
    const rows = await db.select().from(daemons).where(and(eq(daemons.ownerId, user.id), eq(daemons.hostname, "devbox")));
    expect(rows).toHaveLength(1);
    const tokens = await db.select().from(apiTokens).where(and(eq(apiTokens.userId, user.id), eq(apiTokens.daemonOnly, true), eq(apiTokens.name, "Daemon @ devbox")));
    const current = tokens.find((token) => token.id === rows[0]!.tokenId)!;
    expect(current.revokedAt).toBeNull();
    expect(current.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 29 * DAY_MS);
    for (const token of tokens.filter((token) => token.id !== current.id)) {
      expect(token.expiresAt!.getTime()).toBeLessThanOrEqual(Date.now() + GRACE_MS + 5_000);
    }
  } finally {
    await db.delete(users).where(eq(users.id, user.id));
  }
});

test("a rotated Daemon credential still claims Runs during the 10-minute grace period, then is refused", async () => {
  await withRollback(db, async (transaction) => {
    const { personal } = await personalTokenFor(transaction);
    const { register, claim } = setup(transaction);
    const first = await (await register(personal)).json() as { daemonToken: string };
    // Put the old credential under 7 days from expiry so the next registration rotates it.
    const oldRow = await rowOf(transaction, first.daemonToken);
    await transaction.update(apiTokens).set({ expiresAt: new Date(Date.now() + 6 * DAY_MS) }).where(eq(apiTokens.id, oldRow.id));
    const rotated = await (await register(personal)).json() as { daemonToken?: string };
    expect(rotated.daemonToken).toStartWith("weft_daemon_");
    expect(rotated.daemonToken).not.toBe(first.daemonToken);
    // Grace: the old credential is accepted and expires about 10 minutes after rotation; it is not revoked yet.
    const afterRotation = await rowOf(transaction, first.daemonToken);
    expect(afterRotation.revokedAt).toBeNull();
    const remaining = afterRotation.expiresAt!.getTime() - Date.now();
    expect(remaining).toBeGreaterThan(GRACE_MS - 60_000);
    expect(remaining).toBeLessThanOrEqual(GRACE_MS + 1_000);
    expect((await claim(first.daemonToken)).status).toBe(200);
    expect((await claim(rotated.daemonToken!)).status).toBe(200);
    // Time passes beyond the grace period (the test sets the old credential's expiry into the past).
    await transaction.update(apiTokens).set({ expiresAt: new Date(Date.now() - 1_000) }).where(eq(apiTokens.id, oldRow.id));
    expect((await claim(first.daemonToken)).status).toBe(401);
    expect((await claim(rotated.daemonToken!)).status).toBe(200);
  });
});

test("a later registration revokes a rotated Daemon credential once its grace period has passed", async () => {
  await withRollback(db, async (transaction) => {
    const { personal } = await personalTokenFor(transaction);
    const { register } = setup(transaction);
    const first = await (await register(personal)).json() as { daemonToken: string };
    const second = await (await register(personal, { rotate: true })).json() as { daemonToken: string };
    const firstRow = await rowOf(transaction, first.daemonToken);
    // The first credential's grace has passed when the third registration arrives.
    await transaction.update(apiTokens).set({ expiresAt: new Date(Date.now() - 1_000) }).where(eq(apiTokens.id, firstRow.id));
    const third = await (await register(personal, { rotate: true })).json() as { daemonToken: string };
    expect((await rowOf(transaction, first.daemonToken)).revokedAt).not.toBeNull();
    expect((await rowOf(transaction, second.daemonToken)).revokedAt).toBeNull();
    expect(third.daemonToken).toStartWith("weft_daemon_");
  });
});
