import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { ActionError, actionRegistry, createActionList, createApiTokenActions, createWorkspaceAction, registerAction, type ActionContext, type SignalBus } from "@weft/actions";
import { and, eq, gt, isNull } from "drizzle-orm";
import { apiTokens, collections, createDatabase, daemons, oauthAccessToken, oauthClient, users, wikiPages, type Database } from "@weft/db";
import { verifyOAuthQueryParams } from "@better-auth/oauth-provider";
import { createAuth } from "./auth";
import { MAX_REGISTRATION_BODY, cleanRegistration, createRegistrationLimiter, dropUnsupportedOAuthParams, isFormBody, withBody } from "./oauth-guard";
import { registerAiRoutes } from "./ai";
import { lazySignalBus, publishChange, registerEventRoutes } from "./events";
import type { LanguageModel } from "ai";
import { createHash } from "node:crypto";
import { createRuntimeActions } from "@weft/actions";

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
  aiOptions: { aiRequestsPerMinute?: number; aiAssistRequestsPerMinute?: number; aiAssistNow?: () => number; aiEnv?: Record<string, string | undefined>; trustedProxyHops?: number } = {},
) {
  function publicContent(value: unknown): unknown {
    // Asset images need an authenticated action to load and the public viewer has no node for them.
    if (Array.isArray(value)) return value.filter((child) => !(child && typeof child === "object" && (child as { type?: unknown }).type === "assetImage")).map(publicContent);
    if (!value || typeof value !== "object") return value;
    const node = value as Record<string, unknown>;
    if (node.type === "mention") {
      const attrs = node.attrs && typeof node.attrs === "object" ? node.attrs as Record<string, unknown> : {};
      const id = typeof attrs.id === "string" ? attrs.id : "";
      const text = id.startsWith("work-item:")
        ? (typeof attrs.label === "string" ? attrs.label : id.slice("work-item:".length))
        : "@member";
      return { type: "text", text };
    }
    return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, publicContent(child)]));
  }
  const workspaceAction = createWorkspaceAction(db, { ...gates, bucketName: Bun.env.S3_BUCKET ?? "weft-assets" });
  const auth = createAuth(db, workspaceAction.canSignUp);
  const memberActions = createActionList(db);
  const tokens = createApiTokenActions(db);
  const runtimes = createRuntimeActions(db);
  const registrationLimiter = createRegistrationLimiter({ trustedProxyHops: aiOptions.trustedProxyHops ?? Number(Bun.env.TRUSTED_PROXY_HOPS ?? 0) });
  /** Cookie session first (unchanged), then a personal API token in `Authorization: Bearer`. */
  async function resolveCaller(request: Request): Promise<ActionContext | null> {
    const bearer = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (bearer) {
      const source = request.headers.get("x-weft-source") === "mcp" ? "mcp" : "cli";
      const token = bearer.trim();
      if (token.startsWith("weft_")) {
        const owner = await tokens.authenticateWithToken(token);
        return owner ? { userId: owner.userId, apiTokenId: owner.tokenId, source, via: "token" } : null;
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
    .get("/api/cli/login", async ({ request, set }) => {
      const url = new URL(request.url);
      const callback = url.searchParams.get("callback") ?? "";
      const state = url.searchParams.get("state") ?? "";
      const machine = (url.searchParams.get("hostname") ?? "computer").trim().slice(0, 200) || "computer";
      let destination: URL;
      try { destination = new URL(callback); } catch { set.status = 400; return { error: "Invalid local callback" }; }
      if (destination.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(destination.hostname) || !destination.port || destination.username || destination.password || !state || state.length > 200) {
        set.status = 400; return { error: "Invalid local callback" };
      }
      const caller = await resolveCaller(request);
      if (!caller || caller.via !== "session") {
        const loginUrl = `${url.pathname}${url.search}`;
        return Response.redirect(`${Bun.env.WEB_ORIGIN ?? "http://localhost:5173"}/?cli_login=${encodeURIComponent(loginUrl)}`, 302);
      }
      const created = await tokens.createApiToken.handler({ userId: caller.userId, via: "session" }, { name: `Daemon @ ${machine}` });
      destination.searchParams.set("state", state);
      destination.searchParams.set("token", created.token);
      set.headers["cache-control"] = "no-store";
      return Response.redirect(destination.toString(), 302);
    })
    .get("/published/:token", async ({ params, set }) => {
      set.headers["cache-control"] = "no-store";
      set.headers["referrer-policy"] = "no-referrer";
      const tokenHash = createHash("sha256").update(params.token).digest("hex");
      const [page] = await db.select({ title: wikiPages.title, content: wikiPages.content, visibility: collections.visibility }).from(wikiPages).innerJoin(collections, eq(collections.id, wikiPages.collectionId))
        .where(and(eq(wikiPages.publishedTokenHash, tokenHash), isNull(wikiPages.projectId), eq(wikiPages.access, "public"), isNull(wikiPages.deletedAt), isNull(wikiPages.archivedAt)));
      if (!page || page.visibility === "private") { set.status = 404; return { error: "Not found" }; }
      return { title: page.title, content: publicContent(page.content) };
    })
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
  registerAiRoutes(app, { db, resolveCaller, bus, model: aiModel, requestsPerMinute: aiOptions.aiRequestsPerMinute, assistRequestsPerMinute: aiOptions.aiAssistRequestsPerMinute, assistNow: aiOptions.aiAssistNow, env: aiOptions.aiEnv });
  app.ws("/api/daemon", {
    open: async (socket) => {
      const token = socket.data.query?.token;
      if (!token || typeof token !== "string") { socket.close(1008, "Personal API token required"); return; }
      const caller = await tokens.authenticateWithToken(token);
      if (!caller) { socket.close(1008, "Unauthenticated"); return; }
    },
    message: async (socket, message) => {
      if (message !== "heartbeat" && !(message && typeof message === "object" && (message as { type?: unknown }).type === "heartbeat")) {
        socket.close(1003, "Unsupported daemon frame"); return;
      }
      const token = socket.data.query?.token;
      const caller = typeof token === "string" ? await tokens.authenticateWithToken(token) : null;
      if (!caller) {
        const tokenHash = createHash("sha256").update(token ?? "").digest("hex");
        const [tokenRow] = await db.select({ id: apiTokens.id }).from(apiTokens).where(eq(apiTokens.tokenHash, tokenHash));
        if (tokenRow) await runtimes.markTokenDaemonsOffline(tokenRow.id);
        socket.close(1008, "Personal API token revoked"); return;
      }
      if (!caller.tokenId) { socket.close(1008, "Personal API token required"); return; }
      const [daemon] = await db.select({ id: daemons.id }).from(daemons).where(eq(daemons.tokenId, caller.tokenId));
      if (!daemon) { socket.close(1008, "Daemon registration required"); return; }
      await runtimes.heartbeat({ userId: caller.userId }, daemon.id);
      socket.send(JSON.stringify({ type: "heartbeat_ack", at: new Date().toISOString() }));
    },
  });
  return app;
}
