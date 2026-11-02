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
  /** Recent anonymous client registrations per caller IP. */
  const registrations = new Map<string, number[]>();
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
      const payload = await request.clone().json().catch(() => null) as { token_endpoint_auth_method?: string; client_secret?: string; client_name?: unknown; redirect_uris?: unknown } | null;
      if (payload?.token_endpoint_auth_method !== "none" || payload?.client_secret) {
        set.status = 400;
        return { error: "invalid_client_metadata", error_description: "Only public OAuth clients are supported" };
      }
      // Registration needs no sign-in, so bound what one anonymous caller can store and how fast.
      if ((typeof payload.client_name === "string" && payload.client_name.length > 100) || (Array.isArray(payload.redirect_uris) && payload.redirect_uris.length > 5)) {
        set.status = 400;
        return { error: "invalid_client_metadata", error_description: "client_name is limited to 100 characters and redirect_uris to 5 entries" };
      }
      const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
      const now = Date.now();
      const recent = (registrations.get(ip) ?? []).filter((time) => now - time < 60 * 60 * 1000);
      if (recent.length >= 20) {
        set.status = 429;
        return { error: "too_many_requests", error_description: "Too many client registrations; try again later" };
      }
      registrations.set(ip, [...recent, now]);
      return auth.handler(request);
    })
    // MCP clients send an RFC 8707 `resource` and scopes such as `openid`; Weft issues opaque, user-wide tokens, so both are dropped here.
    .get("/api/auth/oauth2/authorize", ({ request }) => {
      const url = new URL(request.url);
      url.searchParams.delete("resource");
      const scope = url.searchParams.get("scope");
      if (scope !== null) {
        const kept = scope.split(/\s+/).filter((name) => name === "offline_access");
        if (kept.length) url.searchParams.set("scope", kept.join(" ")); else url.searchParams.delete("scope");
      }
      return auth.handler(new Request(url, request));
    })
    .post("/api/auth/oauth2/token", async ({ request }) => {
      if (!(request.headers.get("content-type") ?? "").includes("application/x-www-form-urlencoded")) return auth.handler(request);
      const form = new URLSearchParams(await request.text());
      form.delete("resource");
      const headers = new Headers(request.headers);
      headers.delete("content-length");
      return auth.handler(new Request(request.url, { method: "POST", headers, body: form }));
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
