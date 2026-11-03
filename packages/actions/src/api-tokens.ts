import { Type } from "@sinclair/typebox";
import { and, desc, eq, gt, isNull, or, sql } from "drizzle-orm";
import type { Database } from "@weft/db";
import { apiTokens, oauthAccessToken, oauthClient, oauthConsent, oauthRefreshToken } from "@weft/db";
import { ActionError } from "./members";

type Context = { userId: string; via?: "session" | "token" | "oauth" };

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Buffer.from(digest).toString("hex");
}

/** Personal API tokens: owned by a user, hashed at rest, no scopes, not bound to a workspace. */
export function createApiTokenActions(db: Database) {
  const tokenOutput = Type.Object({
    id: Type.String(), name: Type.String(), prefix: Type.String(), createdAt: Type.String(),
    description: Type.Union([Type.String(), Type.Null()]), expiresAt: Type.Union([Type.String(), Type.Null()]),
    status: Type.Union([Type.Literal("active"), Type.Literal("expired"), Type.Literal("revoked")]),
    lastUsedAt: Type.Union([Type.String(), Type.Null()]), revokedAt: Type.Union([Type.String(), Type.Null()]),
  });
  // A token must not mint, list, or revoke tokens: managing tokens needs a signed-in session.
  const requireSession = (context: Context) => {
    if (context.via && context.via !== "session") throw new ActionError("Tokens can only be managed from a signed-in session", 403);
  };
  const authenticateWithToken = async (token: string): Promise<{ userId: string; tokenId: string } | null> => {
    if (!token.startsWith("weft_")) return null;
    const now = new Date();
    const [row] = await db.update(apiTokens).set({ lastUsedAt: new Date() })
      .where(and(eq(apiTokens.tokenHash, await sha256(token)), isNull(apiTokens.revokedAt), or(isNull(apiTokens.expiresAt), gt(apiTokens.expiresAt, now))))
      .returning({ userId: apiTokens.userId, tokenId: apiTokens.id });
    return row ? { userId: row.userId, tokenId: row.tokenId } : null;
  };
  return {
    listAuthorizedApps: {
      name: "list_authorized_apps", kind: "read" as const,
      input: Type.Object({}),
      output: Type.Array(Type.Object({ id: Type.String(), name: Type.String(), allowedAt: Type.String(), lastUsedAt: Type.Union([Type.String(), Type.Null()]) })),
      handler: async (context: Context, _input: Record<string, never>) => {
        requireSession(context);
        const rows = await db.select({ id: oauthClient.clientId, name: oauthClient.name, allowedAt: oauthConsent.createdAt, lastUsedAt: sql<Date | null>`max(${oauthAccessToken.createdAt})` })
          .from(oauthConsent).innerJoin(oauthClient, eq(oauthConsent.clientId, oauthClient.clientId))
          .leftJoin(oauthAccessToken, and(eq(oauthAccessToken.clientId, oauthClient.clientId), eq(oauthAccessToken.userId, context.userId)))
          .where(eq(oauthConsent.userId, context.userId)).groupBy(oauthClient.clientId, oauthClient.name, oauthConsent.createdAt)
          .orderBy(desc(oauthConsent.createdAt));
        return rows.map((row) => ({ id: row.id, name: row.name ?? "An application", allowedAt: (row.allowedAt ?? new Date(0)).toISOString(), lastUsedAt: row.lastUsedAt ? new Date(row.lastUsedAt).toISOString() : null }));
      },
    },
    revokeAuthorizedApp: {
      name: "revoke_authorized_app", kind: "write" as const,
      input: Type.Object({ clientId: Type.String({ minLength: 1 }) }),
      output: Type.Object({ id: Type.String() }),
      handler: async (context: Context, input: { clientId: string }) => {
        requireSession(context);
        const [consent] = await db.select({ id: oauthConsent.id }).from(oauthConsent).where(and(eq(oauthConsent.userId, context.userId), eq(oauthConsent.clientId, input.clientId))).limit(1);
        if (!consent) throw new ActionError("Authorized app not found", 404);
        const now = new Date();
        await db.update(oauthAccessToken).set({ revoked: now }).where(and(eq(oauthAccessToken.userId, context.userId), eq(oauthAccessToken.clientId, input.clientId), isNull(oauthAccessToken.revoked)));
        await db.update(oauthRefreshToken).set({ revoked: now }).where(and(eq(oauthRefreshToken.userId, context.userId), eq(oauthRefreshToken.clientId, input.clientId), isNull(oauthRefreshToken.revoked)));
        await db.delete(oauthConsent).where(and(eq(oauthConsent.userId, context.userId), eq(oauthConsent.clientId, input.clientId)));
        return { id: input.clientId };
      },
    },
    createApiToken: {
      name: "create_api_token", kind: "write" as const,
      input: Type.Object({
        name: Type.String({ minLength: 1, maxLength: 100 }),
        description: Type.Optional(Type.String({ maxLength: 500 })),
        expiresAt: Type.Optional(Type.String()),
      }),
      output: Type.Object({ id: Type.String(), name: Type.String(), token: Type.String() }),
      handler: async (context: Context, input: { name: string; description?: string; expiresAt?: string }) => {
        requireSession(context);
        let expiresAt: Date | undefined;
        if (input.expiresAt !== undefined) {
          expiresAt = new Date(input.expiresAt);
          const datePart = input.expiresAt.slice(0, 10);
          const validFormat = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?$/i.test(input.expiresAt);
          const validCalendarDate = /^\d{4}-\d{2}-\d{2}$/.test(datePart)
            && new Date(`${datePart}T00:00:00.000Z`).toISOString().slice(0, 10) === datePart;
          if (!validFormat || !validCalendarDate || !Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
            throw new ActionError("Expiry must be a valid future date", 400);
          }
        }
        const bytes = crypto.getRandomValues(new Uint8Array(32));
        const token = `weft_${Buffer.from(bytes).toString("hex")}`;
        const [row] = await db.insert(apiTokens).values({
          userId: context.userId, name: input.name, description: input.description ?? null,
          expiresAt, tokenHash: await sha256(token), tokenPrefix: token.slice(0, 9),
        }).returning({ id: apiTokens.id });
        return { id: row!.id, name: input.name, token };
      },
    },
    listApiTokens: {
      name: "list_api_tokens", kind: "read" as const,
      input: Type.Object({}),
      output: Type.Array(tokenOutput),
      handler: async (context: Context, _input: Record<string, never>) => {
        requireSession(context);
        const rows = await db.select().from(apiTokens).where(eq(apiTokens.userId, context.userId)).orderBy(desc(apiTokens.createdAt), desc(apiTokens.id));
        return rows.map((row) => ({
          id: row.id, name: row.name, prefix: row.tokenPrefix, createdAt: row.createdAt.toISOString(),
          description: row.description, expiresAt: row.expiresAt?.toISOString() ?? null,
          status: row.revokedAt ? "revoked" as const : row.expiresAt && row.expiresAt <= new Date() ? "expired" as const : "active" as const,
          lastUsedAt: row.lastUsedAt?.toISOString() ?? null, revokedAt: row.revokedAt?.toISOString() ?? null,
        }));
      },
    },
    revokeApiToken: {
      name: "revoke_api_token", kind: "write" as const,
      input: Type.Object({ tokenId: Type.String({ format: "uuid" }) }),
      output: Type.Object({ id: Type.String() }),
      handler: async (context: Context, input: { tokenId: string }) => {
        requireSession(context);
        const [row] = await db.update(apiTokens).set({ revokedAt: new Date() })
          .where(and(eq(apiTokens.id, input.tokenId), eq(apiTokens.userId, context.userId), isNull(apiTokens.revokedAt)))
          .returning({ id: apiTokens.id });
        if (!row) throw new ActionError("Token not found", 404);
        return { id: row.id };
      },
    },
    /** Resolve a bearer token to its owner; revoked or unknown tokens give null. */
    authenticate: async (token: string): Promise<{ userId: string } | null> => {
      const row = await authenticateWithToken(token);
      return row ? { userId: row.userId } : null;
    },
    authenticateWithToken,
  };
}
