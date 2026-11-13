import { Elysia } from "elysia";
import { Type } from "@sinclair/typebox";
import { cors } from "@elysiajs/cors";
import { createMailerFromEnv, type Mailer, ActionError, AgentAccessDeniedError, actionRegistry, createActionList, createApiTokenActions, createRuntimeDispatchActions, aiWriteActions, HIDDEN_FROM_AI, skillWriteActions, createWorkspaceAction, registerAction, writeDecision, type ActionContext, type SignalBus } from "@weft/actions";
import { and, eq, gt, isNull } from "drizzle-orm";
import { agents, apiTokens, collections, comments, createDatabase, oauthAccessToken, oauthClient, runs, runtimes, users, wikiPages, workItems, type Database } from "@weft/db";
import { verifyOAuthQueryParams } from "@better-auth/oauth-provider";
import { createAuth, minimumPasswordLength, type AuthOptions } from "./auth";
import { microsoftAuthSettings, microsoftEnabled } from "./microsoft-auth";
import { MAX_REGISTRATION_BODY, cleanRegistration, createRegistrationLimiter, dropUnsupportedOAuthParams, isFormBody, withBody } from "./oauth-guard";
import { registerAiRoutes } from "./ai";
import { lazySignalBus, publishChange, registerEventRoutes } from "./events";
import type { LanguageModel } from "ai";
import { createHash } from "node:crypto";

/** Largest repository webhook body accepted. */
const MAX_WEBHOOK_BODY = 5 * 1024 * 1024;
import { createRuntimeActions, daemonForCredential } from "@weft/actions";
import { integrationsEnabled, receiveRepositoryWebhook } from "@weft/actions";
import { agentActionRefusal, agentMayUseAction } from "@weft/actions";
import { isLocale, type Locale } from "@weft/shared";
import { withRequestLog } from "./request-log";
import { defaultHealthProbes, readiness, type HealthProbes } from "./health";
import { HOUR_MS, MINUTE_MS, clientAddress, createSignInThrottle, createWindowCounter, rateLimitSettings, submittedEmail, type RateLimitSettings, type SignInRefusal } from "./rate-limits";

function setting(name: string, defaultValue: boolean) {
  const value = Bun.env[name];
  return value === undefined ? defaultValue : value.toLowerCase() === "true";
}

type LimitedSet = { status?: number | string; headers: Record<string, string | number | undefined> };

/** Answers 429 with Retry-After. The body names the refusal code and the wait, so the web form can say how long to wait. */
function limited(set: LimitedSet, code: string, retryAfterSeconds: number, error: string) {
  set.status = 429;
  set.headers["retry-after"] = String(retryAfterSeconds);
  return { code, error, retryAfterSeconds };
}

function signInRefused(set: LimitedSet, refusal: SignInRefusal) {
  const error = refusal.code === "SIGN_IN_LOCKED"
    ? `Too many failed sign-in attempts. Wait ${Math.ceil(refusal.retryAfterSeconds / 60)} minutes and try again.`
    : `Wait ${refusal.retryAfterSeconds} seconds before trying again.`;
  return limited(set, refusal.code, refusal.retryAfterSeconds, error);
}

function addressLimited(set: LimitedSet, code: string, retryAfterSeconds: number) {
  return limited(set, code, retryAfterSeconds, `Too many requests from this network. Wait ${Math.ceil(retryAfterSeconds / 60)} minutes and try again.`);
}

/** The body as text, or null as soon as it passes `limit` bytes. */
async function readCapped(request: Request, limit: number): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) { await reader.cancel().catch(() => undefined); return null; }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function createApp(
  context?: ActionContext,
  db: Database = createDatabase().db,
  gates = { allowSignup: setting("ALLOW_SIGNUP", true), allowWorkspaceCreation: setting("ALLOW_WORKSPACE_CREATION", true) },
  aiModel?: LanguageModel,
  bus: SignalBus = lazySignalBus(),
  aiOptions: { aiRequestsPerMinute?: number; aiAssistRequestsPerMinute?: number; aiAssistNow?: () => number; aiEnv?: Record<string, string | undefined>; trustedProxyHops?: number; defaultLanguage?: string } = {},
  passwordOptions: { rangeChecker?: import("./password-policy").RangeChecker; online?: boolean; minimum?: number } = {},
  operations: { health?: HealthProbes; log?: (line: string) => void } = {},
  /** Sends account and notification email. Defaults to SMTP_HOST / SMTP_FROM from the environment; null means email is off. */
  mail: Mailer | null = createMailerFromEnv(),
  authOptions: AuthOptions = {},
  /** Feature switches. integrations defaults to WEFT_INTEGRATIONS_ENABLED (only "true" turns it on). */
  features: { integrations?: boolean } = {},
  /** Rate limits. settings default to the environment (see rate-limits.ts); now is the clock, injectable for tests. */
  limits: { settings?: Partial<RateLimitSettings>; now?: () => number } = {},
) {
  const integrations = features.integrations ?? integrationsEnabled();
  const limitSettings: RateLimitSettings = { ...rateLimitSettings(), ...limits.settings };
  const limitClock = limits.now ?? Date.now;
  const trustedProxyHops = aiOptions.trustedProxyHops ?? Number(Bun.env.TRUSTED_PROXY_HOPS ?? 0);
  const signInThrottle = createSignInThrottle(limitSettings, limitClock);
  const addressCounter = createWindowCounter(limitClock);
  const apiCounter = createWindowCounter(limitClock);
  const configuredLanguage = aiOptions.defaultLanguage ?? Bun.env.DEFAULT_LANGUAGE;
  const minPasswordLength = passwordOptions.minimum ?? minimumPasswordLength();
  const defaultLocale: Locale | null = configuredLanguage === undefined || configuredLanguage === "" ? null : isLocale(configuredLanguage) ? configuredLanguage : null;
  if (configuredLanguage && !isLocale(configuredLanguage)) console.warn(`Ignoring invalid DEFAULT_LANGUAGE=${configuredLanguage}; expected en or th.`);
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
  const auth = createAuth(db, workspaceAction.canSignUp, { ...passwordOptions, minimum: minPasswordLength, ...authOptions }, mail ? { mailer: mail, defaultLocale } : null);
  const microsoft = authOptions.microsoft ?? microsoftAuthSettings();
  const passwordSignInEnabled = authOptions.passwordSignInEnabled ?? (Bun.env.PASSWORD_SIGN_IN_ENABLED ?? "true").toLowerCase() !== "false";
  const cookieSecure = (Bun.env.WEFT_PUBLIC_URL ?? Bun.env.BETTER_AUTH_URL ?? "http://localhost:3000").startsWith("https://");
  const memberActions = createActionList(db, { integrations, passwordSignInEnabled });
  const tokens = createApiTokenActions(db);
  const runtimeActions = createRuntimeActions(db);
  const runtimeDispatch = createRuntimeDispatchActions(db);
  const registrationLimiter = createRegistrationLimiter({ trustedProxyHops });
  /** Cookie session first (unchanged), then a personal API token in `Authorization: Bearer`. */
  async function resolveCaller(request: Request): Promise<ActionContext | null> {
    const bearer = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (bearer) {
      const source = request.headers.get("x-weft-source") === "mcp" ? "mcp" : "cli";
      const token = bearer.trim();
      if (token.startsWith("weft_run_")) {
        const run = await runtimeDispatch.authenticateRunToken(token);
        const [agent] = run ? await db.select({ allowProjectActions: agents.allowProjectActions, allowMemberActions: agents.allowMemberActions, allowFeatureActions: agents.allowFeatureActions, allowExportActions: agents.allowExportActions }).from(agents).where(eq(agents.userId, run.agentUserId)) : [];
        return run && agent ? { userId: run.userId, source: "agent", via: "token", agent: { agentUserId: run.agentUserId, runId: run.runId, originatorId: run.userId, autopilot: true, workspaceId: run.workspaceId, ...agent } } : null;
      }
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
    return session ? { userId: session.user.id, via: "session", sessionId: session.session.id } : null;
  }
  /** The Daemon credential's owner, and the Daemon row it speaks for (none when the Daemon was never registered). */
  async function resolveDaemonCaller(request: Request): Promise<(ActionContext & { daemonId?: string }) | null> {
    const bearer = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
    if (!bearer) return null;
    const daemon = await tokens.authenticateDaemonToken(bearer);
    if (!daemon) return null;
    const row = await daemonForCredential(db, { tokenId: daemon.tokenId, userId: daemon.userId });
    return { userId: daemon.userId, apiTokenId: daemon.tokenId, daemonId: row?.id, via: "token", source: "cli" };
  }
  // A forced reset closes every route for the person until a new password is saved (web, API, CLI, MCP and Daemon alike).
  // Only the password change, sign-out and the public configuration and health probes stay open.
  const passwordResetOpenPaths = new Set(["/api/account/change-password", "/api/auth/sign-out", "/api/auth/request-password-reset", "/api/auth/forget-password", "/api/auth/reset-password", "/api/config", "/api/health/live", "/api/health/ready"]);
  const passwordResetGate = async ({ request, set }: { request: Request; set: { status?: number | string; headers: Record<string, string | number | undefined> } }) => {
    const path = new URL(request.url).pathname;
    if (passwordResetOpenPaths.has(path) || path.startsWith("/api/auth/reset-password/")) return;
    const caller = path.startsWith("/api/daemon") ? await resolveDaemonCaller(request) : await resolveCaller(request);
    if (!caller) return;
    const [pending] = await db.select({ forcePasswordReset: users.forcePasswordReset, securityNotice: users.securityNotice }).from(users).where(eq(users.id, caller.userId));
    if (!pending?.forcePasswordReset) return;
    // The CORS plugin does not decorate a response that a hook returns early, so the web app would see a network error instead of the reset code.
    set.headers["access-control-allow-origin"] = Bun.env.WEB_ORIGIN ?? "http://localhost:5173";
    set.headers["access-control-allow-credentials"] = "true";
    set.headers.vary = "Origin";
    set.status = 403;
    return { error: "Choose a new password before you continue.", code: "PASSWORD_RESET_REQUIRED", notice: pending.securityNotice };
  };
  const resetRequested = async ({ request, set }: { request: Request; set: { status?: number | string; headers: Record<string, string | number | undefined> } }) => {
    const counted = addressCounter.take(`reset:${clientAddress(request, trustedProxyHops)}`, limitSettings.resetPerAddressPerHour, HOUR_MS);
    if (!counted.allowed) return addressLimited(set, "PASSWORD_RESET_LIMITED", counted.retryAfterSeconds);
    return auth.handler(request);
  };
  // Only a JSON body is read for the email, so another content type (form-urlencoded) is refused instead of skipping the per-account wait and lock.
  const signInEmail = async ({ request, set }: { request: Request; set: { status?: number | string; headers: Record<string, string | number | undefined> } }) => {
    if (!/^application\/json\b/i.test(request.headers.get("content-type") ?? "")) {
      set.status = 415;
      return { code: "UNSUPPORTED_MEDIA_TYPE", message: "Send the sign-in as JSON." };
    }
    const email = await submittedEmail(request);
    const address = clientAddress(request, trustedProxyHops);
    const refusal = signInThrottle.check(email, address);
    if (refusal) return signInRefused(set, refusal);
    const response = await auth.handler(request);
    if (response.ok) signInThrottle.succeed(email);
    else if (response.status === 401) signInThrottle.fail(email, address);
    return response;
  };
  const app = registerAction(withRequestLog(new Elysia(), operations.log).use(cors({ origin: Bun.env.WEB_ORIGIN ?? "http://localhost:5173", credentials: true })), actionRegistry.hello, context)
    .onBeforeHandle(passwordResetGate)
    // The newest CLI version the operator published (WEFT_CLI_LATEST_VERSION). No sign-in: it reveals nothing private.
    .get("/api/cli/version", () => ({ latest: Bun.env.WEFT_CLI_LATEST_VERSION?.trim() || null }))
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
      // A normal Personal API token for CLI commands; the Daemon gets its own credential from register_daemon.
      const cli = await tokens.createCliToken(caller.userId, `CLI @ ${machine}`);
      destination.searchParams.set("state", state);
      destination.searchParams.set("token", cli.token);
      set.headers["cache-control"] = "no-store";
      return Response.redirect(destination.toString(), 302);
    })
    // Repository webhooks (GitHub, GitLab). No sign-in: the request is authenticated by its signature and the integration id in the path.
    .post("/api/webhooks/work-items/:provider/:integrationId", async ({ params, request, set }) => {
      // Off by default: answer before reading the body or touching the database.
      if (!integrations) { set.status = 404; return { error: "Not found" }; }
      if (Number(request.headers.get("content-length") ?? 0) > MAX_WEBHOOK_BODY) { set.status = 413; return { error: "Webhook body is too large" }; }
      // Read as a stream and stop at the cap, so a body with no or a false content-length cannot fill memory.
      const rawBody = await readCapped(request, MAX_WEBHOOK_BODY);
      if (rawBody === null) { set.status = 413; return { error: "Webhook body is too large" }; }
      const result = await receiveRepositoryWebhook(db, { integrationId: params.integrationId, provider: params.provider, header: (name) => request.headers.get(name), rawBody });
      set.status = result.status;
      return result.body;
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
    .post("/api/daemon/register", async ({ request, body, set }) => {
      // Registration takes the Personal API token only; the Daemon credential it returns cannot register again.
      const bearer = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
      const owner = bearer ? await tokens.authenticateWithToken(bearer) : null;
      if (!owner) { set.status = 401; return { error: "Personal API token expired or invalid. Run `weft login` to sign in again." }; }
      try { return await runtimeActions.registerDaemon.handler({ userId: owner.userId, apiTokenId: owner.tokenId }, body); }
      catch (error) { set.status = error instanceof ActionError ? error.status : 400; return { error: error instanceof Error ? error.message : "Daemon registration failed" }; }
    }, { body: runtimeActions.registerDaemon.input })
    .post("/api/daemon/runs/claim", async ({ request, set }) => {
      const caller = await resolveDaemonCaller(request);
      if (!caller?.apiTokenId) { set.status = 401; return { error: "Daemon credential expired or invalid. Run `weft login` to sign in again." }; }
      if (!caller.daemonId) { set.status = 403; return { error: "Daemon is not registered" }; }
      return runtimeDispatch.claimRuns({ userId: caller.userId, daemonId: caller.daemonId }, 20);
    })
    .post("/api/daemon/stop", async ({ request, set }) => {
      const caller = await resolveDaemonCaller(request);
      if (!caller?.apiTokenId) { set.status = 401; return { error: "Daemon credential expired or invalid. Run `weft login` to sign in again." }; }
      if (!caller.daemonId) { set.status = 403; return { error: "Daemon is not registered" }; }
      await runtimeDispatch.stopDaemon(caller.daemonId, caller.userId);
      return { ok: true };
    }, { body: Type.Object({}) })
    .post("/api/daemon/runs/start", async ({ request, body, set }) => {
      const caller = await resolveDaemonCaller(request); if (!caller?.apiTokenId) { set.status = 401; return { error: "Daemon credential expired or invalid. Run `weft login` to sign in again." }; }
      const [runtime] = caller.daemonId ? await db.select({ id: runtimes.id }).from(runtimes).where(and(eq(runtimes.daemonId, caller.daemonId), eq(runtimes.id, body.runtimeId))) : [];
      if (!runtime) { set.status = 403; return { error: "Runtime not found" }; }
      await runtimeDispatch.startRun(body.runId, runtime.id); return { ok: true };
    }, { body: Type.Object({ runId: Type.String({ format: "uuid" }), runtimeId: Type.String({ format: "uuid" }) }) })
    .post("/api/daemon/runs/messages", async ({ request, body, set }) => {
      const caller = await resolveDaemonCaller(request); if (!caller?.apiTokenId) { set.status = 401; return { error: "Daemon credential expired or invalid. Run `weft login` to sign in again." }; }
      const [run] = caller.daemonId ? await db.select({ id: runs.id }).from(runs).innerJoin(runtimes, eq(runtimes.id, runs.runtimeId)).where(and(eq(runs.id, body.runId), eq(runtimes.daemonId, caller.daemonId))) : [];
      if (!run) { set.status = 403; return { error: "Run is not assigned to this Daemon" }; }
      await runtimeDispatch.appendMessages(body.runId, body.messages); return { ok: true };
    }, { body: Type.Object({ runId: Type.String({ format: "uuid" }), messages: Type.Array(Type.Object({ seq: Type.Integer(), type: Type.Union([Type.Literal("thought"), Type.Literal("action"), Type.Literal("response"), Type.Literal("error")]), output: Type.Any() })) }) })
    .post("/api/daemon/runs/finish", async ({ request, body, set }) => {
      const caller = await resolveDaemonCaller(request); if (!caller?.apiTokenId) { set.status = 401; return { error: "Daemon credential expired or invalid. Run `weft login` to sign in again." }; }
      const [run] = caller.daemonId ? await db.select({ id: runs.id }).from(runs).innerJoin(runtimes, eq(runtimes.id, runs.runtimeId)).where(and(eq(runs.id, body.runId), eq(runtimes.daemonId, caller.daemonId))) : [];
      if (!run) { set.status = 403; return { error: "Run is not assigned to this Daemon" }; }
      await runtimeDispatch.finishRun(body.runId, body); return { ok: true };
    }, { body: Type.Object({ runId: Type.String({ format: "uuid" }), status: Type.Union([Type.Literal("completed"), Type.Literal("failed")]), finalOutput: Type.String(), failureReason: Type.Optional(Type.String()) }) })
    .post("/api/daemon/runs/cancel-ack", async ({ request, body, set }) => {
      const caller = await resolveDaemonCaller(request); if (!caller?.apiTokenId) { set.status = 401; return { error: "Daemon credential expired or invalid. Run `weft login` to sign in again." }; }
      const [run] = caller.daemonId ? await db.select({ id: runs.id }).from(runs).innerJoin(runtimes, eq(runtimes.id, runs.runtimeId)).where(and(eq(runs.id, body.runId), eq(runtimes.daemonId, caller.daemonId))) : [];
      if (!run) { set.status = 403; return { error: "Run is not assigned to this Daemon" }; }
      await runtimeDispatch.acknowledgeCancel(body.runId); return { ok: true };
    }, { body: Type.Object({ runId: Type.String({ format: "uuid" }) }) })
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
    .get("/api/auth/settings", () => ({ microsoftSignInEnabled: microsoftEnabled(microsoft), passwordSignInEnabled }))
    .post("/api/auth/sign-in/social", async ({ request }) => {
      const response = await auth.handler(request);
      const inviteToken = request.headers.get("x-weft-invite");
      if (!inviteToken || !microsoftEnabled(microsoft) || !response.ok || inviteToken.length > 512) return response;
      const headers = new Headers(response.headers);
      headers.append("set-cookie", `weft_signup_invite=${encodeURIComponent(inviteToken)}; Max-Age=600; Path=/api/auth/callback/microsoft-entra-id; HttpOnly; SameSite=Lax${cookieSecure ? "; Secure" : ""}`);
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    })
    .get("/api/auth/callback/microsoft-entra-id", async ({ request }) => {
      const inviteCookie = request.headers.get("cookie")?.split(";").map((part) => part.trim()).find((part) => part.startsWith("weft_signup_invite="))?.slice("weft_signup_invite=".length);
      const headers = new Headers(request.headers);
      if (inviteCookie) {
        try { headers.set("x-weft-invite", decodeURIComponent(inviteCookie)); } catch { /* Invalid cookie is treated as no invite. */ }
      }
      let response = await auth.handler(new Request(request, { headers }));
      if (!response.ok) {
        const error = await response.clone().json().catch(() => null) as { code?: unknown } | null;
        const code = typeof error?.code === "string" && ["MICROSOFT_WRONG_TENANT", "MICROSOFT_DOMAIN_NOT_ALLOWED", "MICROSOFT_EMAIL_MISSING", "MICROSOFT_INVALID_IDENTITY", "WEFT_INVITE_REQUIRED"].includes(error.code) ? error.code : null;
        if (code) response = Response.redirect(`${Bun.env.WEB_ORIGIN ?? "http://localhost:5173"}/?error=${encodeURIComponent(code)}`, 302);
      }
      if (!inviteCookie) return response;
      const responseHeaders = new Headers(response.headers);
      responseHeaders.append("set-cookie", `weft_signup_invite=; Max-Age=0; Path=/api/auth/callback/microsoft-entra-id; HttpOnly; SameSite=Lax${cookieSecure ? "; Secure" : ""}`);
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers: responseHeaders });
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
    // Sign-in is throttled per account and per address before the password is checked. A refusal never says whether the account exists.
    .post("/api/auth/sign-in/email", signInEmail)
    // Sign-up and reset requests are limited per address only, so a refusal says nothing about any account.
    .post("/api/auth/sign-up/email", async ({ request, set }) => {
      const counted = addressCounter.take(`sign-up:${clientAddress(request, trustedProxyHops)}`, limitSettings.signUpPerAddressPerHour, HOUR_MS);
      if (!counted.allowed) return addressLimited(set, "SIGN_UP_LIMITED", counted.retryAfterSeconds);
      const response = await auth.handler(request);
      // A taken email must look like any other refusal, or the form reveals which addresses have accounts.
      if (!response.ok && /USER_ALREADY_EXISTS/.test(await response.clone().text())) {
        return Response.json({ code: "SIGN_UP_FAILED", message: "Could not create the account." }, { status: response.status });
      }
      return response;
    })
    .post("/api/auth/request-password-reset", resetRequested)
    .post("/api/auth/forget-password", resetRequested)
    .all("/api/auth/*", ({ request, set }) => {
      // Trailing slashes and letter case must not reach better-auth's sign-in without the throttle.
      const path = new URL(request.url).pathname.toLowerCase().replace(/\/+$/, "");
      if (path === "/api/auth/sign-in/email" && request.method === "POST") return signInEmail({ request, set });
      return auth.handler(request);
    })
    .get("/api/me", async ({ request, set }) => {
      const caller = await resolveCaller(request);
      if (!caller) { set.status = 401; return { error: "Unauthenticated" }; }
      const workspaces = await workspaceAction.userWorkspaces(caller.userId);
      const [user] = await db.select().from(users).where(eq(users.id, caller.userId));
      return {
        user: { ...user, locale: user.locale ?? defaultLocale ?? "en", localeSaved: user.locale !== null }, workspaces, canCreateWorkspace: await workspaceAction.canCreateWorkspace(caller.userId),
        // The forced reset screen and the "why you were signed out" notice both read this.
        account: { forcePasswordReset: user.forcePasswordReset, securityNotice: user.securityNotice },
      };
    })
    .get("/api/config", () => ({ defaultLocale, minPasswordLength, emailEnabled: mail !== null, integrationsEnabled: integrations }))
    // Liveness only says the process answers. Readiness also checks the database and file storage, and names the one that failed.
    .get("/api/health/live", () => ({ status: "ok" }))
    .get("/api/health/ready", async ({ set }) => {
      const result = await readiness(operations.health ?? defaultHealthProbes(db));
      if (result.status !== "ok") set.status = 503;
      return result;
    })
    // Choosing a new password after a forced reset: better-auth checks the current password, then this clears the flag.
    .post("/api/account/change-password", async ({ request, body, set }) => {
      const caller = await resolveCaller(request);
      if (!caller || caller.via !== "session") { set.status = 401; return { error: "Unauthenticated" }; }
      if (body.newPassword === body.currentPassword) { set.status = 400; return { error: "Choose a new password that is different from the current one." }; }
      // Guessing the current password is throttled like signing in, per account and per address, and shares its counters.
      const [person] = await db.select({ email: users.email }).from(users).where(eq(users.id, caller.userId));
      const guessEmail = person?.email.trim().toLowerCase() ?? "";
      const guessAddress = clientAddress(request, trustedProxyHops);
      const refusal = signInThrottle.check(guessEmail, guessAddress);
      if (refusal) return signInRefused(set, refusal);
      const headers = new Headers(request.headers);
      headers.set("content-type", "application/json");
      const response = await auth.handler(new Request(new URL("/api/auth/change-password", request.url), {
        method: "POST", headers, body: JSON.stringify({ currentPassword: body.currentPassword, newPassword: body.newPassword, revokeOtherSessions: true }),
      }));
      if (!response.ok) {
        const failure = await response.json().catch(() => null) as { message?: string; code?: string } | null;
        if (response.status === 401 || failure?.code === "INVALID_PASSWORD") signInThrottle.fail(guessEmail, guessAddress);
        set.status = response.status === 401 ? 401 : 400;
        return { error: failure?.message ?? "The password was not changed." };
      }
      signInThrottle.succeed(guessEmail);
      await db.update(users).set({ forcePasswordReset: false, securityNotice: null, updatedAt: new Date() }).where(eq(users.id, caller.userId));
      const out = new Headers({ "content-type": "application/json" });
      for (const cookie of response.headers.getSetCookie()) out.append("set-cookie", cookie);
      return new Response(JSON.stringify({ ok: true }), { headers: out });
    }, { body: Type.Object({ currentPassword: Type.String({ minLength: 1, maxLength: 200 }), newPassword: Type.String({ minLength: 8, maxLength: 200 }) }) })
    .post("/actions/create_workspace", async ({ body, request, set }) => {
      const caller = await resolveCaller(request);
      if (!caller) { set.status = 401; return { error: "Unauthenticated" }; }
      if (caller.source === "agent") { set.status = 403; return { error: "This action is not available to an Agent Run" }; }
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
      // Personal API tokens (CLI, MCP), OAuth grants and Run tokens share a per-minute cap; browser sessions and the Daemon are not capped here.
      const apiKey = caller.apiTokenId ? `token:${caller.apiTokenId}` : caller.agent ? `run:${caller.agent.runId}` : caller.via === "oauth" ? `oauth:${caller.userId}` : null;
      if (apiKey) {
        const counted = apiCounter.take(apiKey, limitSettings.apiRequestsPerMinute, MINUTE_MS);
        set.headers["ratelimit-limit"] = String(limitSettings.apiRequestsPerMinute);
        set.headers["ratelimit-remaining"] = String(counted.remaining);
        set.headers["ratelimit-reset"] = String(counted.retryAfterSeconds || 60);
        if (!counted.allowed) return limited(set, "rate_limited", counted.retryAfterSeconds, `Too many requests: ${limitSettings.apiRequestsPerMinute} per minute. Wait ${counted.retryAfterSeconds} seconds and try again.`);
      }
      if (caller.source === "agent" && caller.agent) {
        if (action.name.startsWith("delete_")) { set.status = 403; return { error: agentActionRefusal(action.name) }; }
        if (!agentMayUseAction(action.name, {
          allowProjectActions: caller.agent.allowProjectActions === true, allowMemberActions: caller.agent.allowMemberActions === true,
          allowFeatureActions: caller.agent.allowFeatureActions === true, allowExportActions: caller.agent.allowExportActions === true,
        })) { set.status = 403; return { error: agentActionRefusal(action.name) }; }
        const offered = action.kind === "write"
          ? (aiWriteActions as readonly string[]).includes(action.name) && !(skillWriteActions as readonly string[]).includes(action.name) && writeDecision(action.name, true) === "run"
          : !HIDDEN_FROM_AI.has(action.name) && !["list_skills", "list_skill_agents"].includes(action.name);
        const bodyWorkspaceId = (body as { workspaceId?: unknown } | null)?.workspaceId;
        if (!offered || (typeof bodyWorkspaceId === "string" && bodyWorkspaceId !== caller.agent.workspaceId)) { set.status = 403; return { error: agentActionRefusal(action.name) }; }
      }
      try {
        const result = await (action.handler as (context: ActionContext, input: unknown) => Promise<unknown>)(caller, body);
        if (action.kind === "write") await publishChange(db, bus, body, result);
        return result;
      } catch (error) {
        if (error instanceof AgentAccessDeniedError) {
          const [item] = await db.select({ id: workItems.id, workspaceId: workItems.workspaceId, projectId: workItems.projectId }).from(workItems).where(eq(workItems.id, error.workItemId));
          if (item) {
            const note = `${error.message} This request did not start a Run.`;
            await db.insert(comments).values({ workspaceId: item.workspaceId, projectId: item.projectId, workItemId: item.id, authorId: caller.userId,
              body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: note }] }] }, bodyText: note });
          }
          set.status = error.status; return { error: error.message };
        }
        if (error instanceof ActionError) { set.status = error.status; return { error: error.message }; }
        throw error;
      }
    }, { body: action.input });
  }
  registerEventRoutes(app, { db, resolveCaller, bus });
  registerAiRoutes(app, { db, resolveCaller, bus, model: aiModel, requestsPerMinute: aiOptions.aiRequestsPerMinute, assistRequestsPerMinute: aiOptions.aiAssistRequestsPerMinute, assistNow: aiOptions.aiAssistNow, env: { ...process.env, ...aiOptions.aiEnv, DEFAULT_LANGUAGE: configuredLanguage } });
  // Connected Daemons are told about queued work and cancels within seconds, not only when their next heartbeat arrives.
  const daemonSockets = new Map<string, { socket: { send: (data: string) => unknown }; daemonId: string }>();
  let signalTimer: ReturnType<typeof setInterval> | undefined;
  const traceDaemon = (message: string) => { if (Bun.env.WEFT_DAEMON_TRACE === "1") console.log(`[daemon trace] ${message}`); };
  const signalDaemon = async (socket: { send: (data: string) => unknown }, daemonId: string) => {
    const cancelled = await db.select({ id: runs.id }).from(runs).innerJoin(runtimes, eq(runtimes.id, runs.runtimeId)).where(and(eq(runtimes.daemonId, daemonId), eq(runs.status, "stopping")));
    for (const run of cancelled) socket.send(JSON.stringify({ type: "cancel", runId: run.id }));
    const [available] = await db.select({ id: runs.id }).from(runs).innerJoin(agents, eq(agents.id, runs.agentId)).innerJoin(runtimes, eq(runtimes.id, agents.runtimeId))
      .where(and(eq(runs.status, "queued"), eq(runtimes.daemonId, daemonId), eq(runtimes.shared, true))).limit(1);
    if (available) { traceDaemon(`signal queued run ${available.id} to daemon ${daemonId}`); socket.send(JSON.stringify({ type: "work_available" })); }
  };
  app.ws("/api/daemon", {
    open: async (socket) => {
      traceDaemon("websocket opened");
      const token = socket.data.query?.token;
      if (!token || typeof token !== "string") { socket.close(1008, "Daemon credential expired or invalid. Run `weft login` to sign in again."); return; }
      const caller = await tokens.authenticateDaemonToken(token);
      if (!caller) { socket.close(1008, "Unauthenticated"); return; }
    },
    message: async (socket, message) => {
      traceDaemon(`websocket message ${typeof message === "string" ? message : JSON.stringify(message)}`);
      if (message !== "heartbeat" && !(message && typeof message === "object" && (message as { type?: unknown }).type === "heartbeat")) {
        socket.close(1003, "Unsupported daemon frame"); return;
      }
      const token = socket.data.query?.token;
      const caller = typeof token === "string" ? await tokens.authenticateDaemonToken(token) : null;
      if (!caller) {
        const tokenHash = createHash("sha256").update(token ?? "").digest("hex");
        const [tokenRow] = await db.select({ id: apiTokens.id }).from(apiTokens).where(eq(apiTokens.tokenHash, tokenHash));
        if (tokenRow) await runtimeActions.markTokenDaemonsOffline(tokenRow.id);
        socket.close(1008, "Daemon credential revoked or expired"); return;
      }
      const daemon = await daemonForCredential(db, { tokenId: caller.tokenId, userId: caller.userId });
      if (!daemon) { socket.close(1008, "Daemon registration required"); return; }
      // A credential rotated during this connection is superseded: the Daemon reconnects with the one it adopted.
      if (daemon.tokenId !== caller.tokenId) { socket.close(4001, "Daemon credential was replaced. Reconnect to use the new credential."); return; }
      await runtimeActions.heartbeat({ userId: caller.userId }, daemon.id);
      socket.send(JSON.stringify({ type: "heartbeat_ack", at: new Date().toISOString() }));
      daemonSockets.set(socket.id, { socket, daemonId: daemon.id });
      signalTimer ??= setInterval(() => { for (const [id, entry] of daemonSockets) void signalDaemon(entry.socket, entry.daemonId).catch(() => daemonSockets.delete(id)); if (!daemonSockets.size && signalTimer) { clearInterval(signalTimer); signalTimer = undefined; } }, 2_000).unref();
      await signalDaemon(socket, daemon.id);
    },
    close: (socket) => { traceDaemon("websocket closed"); daemonSockets.delete(socket.id); },
  });
  return app;
}
