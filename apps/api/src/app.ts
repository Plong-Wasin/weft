import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { ActionError, actionRegistry, createActionList, createApiTokenActions, createWorkspaceAction, registerAction, type ActionContext, type SignalBus } from "@weft/actions";
import { and, eq, gt, isNull } from "drizzle-orm";
import { createDatabase, oauthAccessToken, oauthClient, users, type Database } from "@weft/db";
import { verifyOAuthQueryParams } from "@better-auth/oauth-provider";
import { createAuth } from "./auth";
import { MAX_REGISTRATION_BODY, cleanRegistration, createRegistrationLimiter, dropUnsupportedOAuthParams, isFormBody, withBody } from "./oauth-guard";
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
  aiOptions: { aiRequestsPerMinute?: number; trustedProxyHops?: number } = {},
) {
  const workspaceAction = createWorkspaceAction(db, gates);
  const auth = createAuth(db, workspaceAction.canSignUp);
  const memberActions = createActionList(db);
  const tokens = createApiTokenActions(db);
  const registrationLimiter = createRegistrationLimiter({ trustedProxyHops: aiOptions.trustedProxyHops ?? Number(Bun.env.TRUSTED_PROXY_HOPS ?? 0) });
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
      // Registration needs no sign-in, so bound what one anonymous caller can store and how fast.
      if (Number(request.headers.get("content-length") ?? 0) > MAX_REGISTRATION_BODY) {
        set.status = 400;
        return { error: "invalid_client_metadata", error_description: "Registration body is limited to 8 KB" };
      }
      const cleaned = cleanRegistration(await request.clone().text());
      if ("error" in cleaned) {
        set.status = 400;
        return { error: "invalid_client_metadata", error_description: cleaned.error };
      }
      if (!registrationLimiter.allow(request)) {
        set.status = 429;
        return { error: "too_many_requests", error_description: "Too many client registrations; try again later" };
      }
      return auth.handler(withBody(request, JSON.stringify(cleaned.payload)));
    })
    .get("/api/auth/oauth2/authorize", ({ request }) => {
      const url = new URL(request.url);
      dropUnsupportedOAuthParams(url.searchParams);
      return auth.handler(new Request(url, request));
    })
    .post("/api/auth/oauth2/authorize", async ({ request }) => {
      if (!isFormBody(request)) return auth.handler(request);
      const form = new URLSearchParams(await request.text());
      dropUnsupportedOAuthParams(form);
      return auth.handler(withBody(request, form));
    })
    .post("/api/auth/oauth2/token", async ({ request }) => {
      if (!isFormBody(request)) return auth.handler(request);
      const form = new URLSearchParams(await request.text());
      dropUnsupportedOAuthParams(form);
      return auth.handler(withBody(request, form));
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
      // Name the host the app actually asked to return to (the signed query carries it); a client may register several redirect URIs.
      const redirect = new URLSearchParams(oauthQuery).get("redirect_uri") ?? client.redirectUris[0];
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
