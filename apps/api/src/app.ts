import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { ActionError, actionRegistry, createActionList, createApiTokenActions, createWorkspaceAction, registerAction, type ActionContext, type SignalBus } from "@weft/actions";
import { and, eq, gt, isNull } from "drizzle-orm";
import { createDatabase, oauthAccessToken, oauthClient, users, type Database } from "@weft/db";
import { verifyOAuthQueryParams } from "@better-auth/oauth-provider";
import { createAuth } from "./auth";
import { registerAiRoutes } from "./ai";
import { lazySignalBus, publishChange, registerEventRoutes } from "./events";
import type { LanguageModel } from "ai";

function setting(name: string, defaultValue: boolean) {
  const value = Bun.env[name];
  return value === undefined ? defaultValue : value.toLowerCase() === "true";
}

export function createApp(
  context?: ActionContext,
  db: Database = createDatabase().db,
  gates = { allowSignup: setting("ALLOW_SIGNUP", true), allowWorkspaceCreation: setting("ALLOW_WORKSPACE_CREATION", true) },
  aiModel?: LanguageModel,
  bus: SignalBus = lazySignalBus(),
  aiOptions: { aiRequestsPerMinute?: number } = {},
) {
  const workspaceAction = createWorkspaceAction(db, gates);
  const auth = createAuth(db, workspaceAction.canSignUp);
  const memberActions = createActionList(db);
  const tokens = createApiTokenActions(db);
  /** Cookie session first (unchanged), then a personal API token in `Authorization: Bearer`. */
  async function resolveCaller(request: Request): Promise<ActionContext | null> {
    const bearer = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (bearer) {
      const source = request.headers.get("x-weft-source") === "mcp" ? "mcp" : "cli";
      const token = bearer.trim();
      if (token.startsWith("weft_")) {
        const owner = await tokens.authenticate(token);
        return owner ? { userId: owner.userId, source, via: "token" } : null;
      }
      const hash = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))).toString("base64url");
      const [access] = await db.select({ userId: oauthAccessToken.userId }).from(oauthAccessToken).where(and(
        eq(oauthAccessToken.token, hash), isNull(oauthAccessToken.revoked), gt(oauthAccessToken.expiresAt, new Date()),
      ));
      return access?.userId ? { userId: access.userId, source, via: "oauth" } : null;
    }
    const session = await auth.api.getSession({ headers: request.headers });
    return session ? { userId: session.user.id, via: "session" } : null;
  }
  const app = registerAction(new Elysia().use(cors({ origin: Bun.env.WEB_ORIGIN ?? "http://localhost:5173", credentials: true })), actionRegistry.hello, context)
    .all("/.well-known/*", ({ request }) => auth.handler(request))
    .post("/api/auth/oauth2/register", async ({ request, set }) => {
      const payload = await request.clone().json().catch(() => null) as { token_endpoint_auth_method?: string; client_secret?: string } | null;
      if (payload?.token_endpoint_auth_method !== "none" || payload?.client_secret) {
        set.status = 400;
        return { error: "invalid_client_metadata", error_description: "Only public OAuth clients are supported" };
      }
      return auth.handler(request);
    })
    .get("/api/oauth/consent-info", async ({ request, set }) => {
      const oauthQuery = new URL(request.url).search.slice(1);
      const { secret } = await auth.$context;
      if (!(await verifyOAuthQueryParams(oauthQuery, secret))) {
        set.status = 400;
        return { error: "Invalid OAuth request" };
      }
      const clientId = new URLSearchParams(oauthQuery).get("client_id");
      if (!clientId) { set.status = 400; return { error: "Missing OAuth client" }; }
      const [client] = await db.select({ name: oauthClient.name, redirectUris: oauthClient.redirectUris }).from(oauthClient).where(eq(oauthClient.clientId, clientId));
      if (!client) { set.status = 404; return { error: "OAuth client not found" }; }
      const redirect = client.redirectUris[0];
      let redirectHost = "unknown host";
      try { redirectHost = new URL(redirect!).host; } catch { /* The provider validates redirect URIs before issuing a consent request. */ }
      return { clientName: client.name ?? "An application", redirectHost };
    })
    .all("/api/auth/*", ({ request }) => auth.handler(request))
    .get("/api/me", async ({ request, set }) => {
      const caller = await resolveCaller(request);
      if (!caller) { set.status = 401; return { error: "Unauthenticated" }; }
      const workspaces = await workspaceAction.userWorkspaces(caller.userId);
      const [user] = await db.select().from(users).where(eq(users.id, caller.userId));
      return { user, workspaces, canCreateWorkspace: await workspaceAction.canCreateWorkspace(caller.userId) };
    })
    .post("/actions/create_workspace", async ({ body, request, set }) => {
      const caller = await resolveCaller(request);
      if (!caller) { set.status = 401; return { error: "Unauthenticated" }; }
      try {
        return await workspaceAction.handler({ userId: caller.userId, source: caller.source }, body);
      } catch (error) {
        set.status = 403;
        return { error: error instanceof Error ? error.message : "Workspace creation failed" };
      }
    }, { body: workspaceAction.input });
  for (const action of memberActions) {
    app.post(`/actions/${action.name}`, async ({ body, request, set }) => {
      const caller = await resolveCaller(request);
      if (!caller) { set.status = 401; return { error: "Unauthenticated" }; }
      try {
        const result = await (action.handler as (context: ActionContext, input: unknown) => Promise<unknown>)(caller, body);
        if (action.kind === "write") await publishChange(db, bus, body, result);
        return result;
      } catch (error) {
        if (error instanceof ActionError) { set.status = error.status; return { error: error.message }; }
        throw error;
      }
    }, { body: action.input });
  }
  registerEventRoutes(app, { db, resolveCaller, bus });
  registerAiRoutes(app, { db, resolveCaller, bus, model: aiModel, requestsPerMinute: aiOptions.aiRequestsPerMinute });
  return app;
}
