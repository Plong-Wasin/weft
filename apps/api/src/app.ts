import { Elysia } from "elysia";
import { Type } from "@sinclair/typebox";
import { cors } from "@elysiajs/cors";
import { createMailerFromEnv, type Mailer, ActionError, AgentAccessDeniedError, actionRegistry, createActionList, createApiTokenActions, createRuntimeDispatchActions, aiWriteActions, HIDDEN_FROM_AI, skillWriteActions, createWorkspaceAction, registerAction, writeDecision, type ActionContext, type SignalBus, containsRuntimeSecretValue, openSecret, recordSecretOutputBlockedNotifications, withAgentRunProjectAuthorization, mintApiToken, DEFAULT_TOKEN_MS, CLI_DEVICE_INACTIVITY_MS, CLI_DEVICE_ROTATION_INTERVAL_MS, lockCliDeviceLifecycle, expireCliDeviceAuthorizations } from "@weft/actions";
import { and, eq, gt, inArray, isNull, lt, sql } from "drizzle-orm";
import { agents, apiTokens, cliDevices, cliDeviceAuthorizations, collections, comments, createDatabase, oauthAccessToken, oauthClient, runs, runtimes, users, wikiPages, workItems, type Database } from "@weft/db";
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
/** The Session a Daemon used for a Runtime Run: the CLI's Session id when it printed one, and whether the Run resumed it. */
const sessionReport = Type.Object({ id: Type.Optional(Type.Union([Type.Null(), Type.String({ maxLength: 200 })])), mode: Type.Union([Type.Literal("resumed"), Type.Literal("new")]), reason: Type.String({ maxLength: 64 }) });
import { createRuntimeActions, daemonForCredential, sanitizeWrittenDocument, withWrittenFormKey } from "@weft/actions";
import { aiState, integrationsEnabled, outboundWebhooksEnabled, receiveRepositoryWebhook, type AiState } from "@weft/actions";
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
  /** Sends account and notification email. Defaults to the Mail transport chosen by MAIL_TRANSPORT (SMTP or Graph); null means email is off. */
  mail: Mailer | null = createMailerFromEnv(),
  authOptions: AuthOptions = {},
  /** Feature switches. integrations defaults to WEFT_INTEGRATIONS_ENABLED and outboundWebhooks to WEFT_OUTBOUND_WEBHOOKS_ENABLED (only "true" turns each on). ai defaults to WEFT_AI_ENABLED and the provider key (see aiState). */
  features: { integrations?: boolean; outboundWebhooks?: boolean; ai?: boolean } = {},
  /** Rate limits. settings default to the environment (see rate-limits.ts); now is the clock, injectable for tests. */
  limits: { settings?: Partial<RateLimitSettings>; now?: () => number } = {},
  /** The clock of the Runtime actions (offline time, freshness, dispatch); injectable for tests. */
  clock: () => Date = () => new Date(),
  assetStorage?: import("@weft/actions").AssetStorage,
) {
  const integrations = features.integrations ?? integrationsEnabled();
  const outboundWebhooks = features.outboundWebhooks ?? outboundWebhooksEnabled();
  const aiSwitch: AiState = features.ai === undefined ? aiState({ ...process.env, ...aiOptions.aiEnv }) : features.ai ? { enabled: true, reason: null } : { enabled: false, reason: "switched_off" };
  const limitSettings: RateLimitSettings = { ...rateLimitSettings(), ...limits.settings };
  const limitClock = limits.now ?? Date.now;
  const trustedProxyHops = aiOptions.trustedProxyHops ?? Number(Bun.env.TRUSTED_PROXY_HOPS ?? 0);
  const signInThrottle = createSignInThrottle(limitSettings, limitClock);
  const addressCounter = createWindowCounter(limitClock);
  const apiCounter = createWindowCounter(limitClock);
  const deviceAuthCounter = createWindowCounter(limitClock);
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
  const memberActions = createActionList(db, { integrations, passwordSignInEnabled, outboundWebhooks, clock, assetStorage });
  const tokens = createApiTokenActions(db, { now: () => new Date(limitClock()) });
  const runtimeActions = createRuntimeActions(db, clock);
  const runtimeDispatch = createRuntimeDispatchActions(db, clock);
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
    // The public origin MCP clients reach the server at (WEFT_PUBLIC_URL), so Connect AI can fill its commands. No sign-in: it is the address a client needs anyway.
    .get("/api/mcp/address", () => {
      const configured = Bun.env.WEFT_PUBLIC_URL?.trim();
      if (!configured) return { publicUrl: null };
      try { const url = new URL(configured); return { publicUrl: url.protocol === "http:" || url.protocol === "https:" ? url.origin : null }; } catch { return { publicUrl: null }; }
    })
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
    // Device authorization keeps the terminal secret separate from the short code the person reviews.
    .post("/api/cli/device-authorization", async ({ request, set }) => {
      const address = clientAddress(request, trustedProxyHops);
      const limit = deviceAuthCounter.take(`start:${address}`, 10, MINUTE_MS);
      if (!limit.allowed) return addressLimited(set, "DEVICE_LOGIN_LIMIT", limit.retryAfterSeconds);
      const body = await request.json().catch(() => null) as { deviceId?: unknown; hostname?: unknown } | null;
      if (!body || typeof body.deviceId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.deviceId) || typeof body.hostname !== "string" || body.hostname.length > 500) {
        set.status = 400; return { error: "Invalid device sign-in request" };
      }
      const deviceSecret = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
      const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
      const randomCode = crypto.getRandomValues(new Uint8Array(8));
      const userCode = Array.from(randomCode, (byte) => alphabet[byte % alphabet.length]).join("");
      const hash = (value: string) => createHash("sha256").update(value).digest("hex");
      const expiresAt = new Date(limitClock() + 5 * MINUTE_MS);
      await db.insert(cliDeviceAuthorizations).values({
        deviceId: body.deviceId, hostname: body.hostname.trim().slice(0, 200) || "computer",
        deviceSecretHash: hash(deviceSecret), userCodeHash: hash(userCode), expiresAt,
      });
      const webOrigin = (Bun.env.WEB_ORIGIN ?? "http://localhost:5173").replace(/\/$/, "");
      set.status = 201;
      set.headers["cache-control"] = "no-store";
      set.headers["referrer-policy"] = "no-referrer";
      return { deviceSecret, userCode, verificationUrl: `${webOrigin}/cli/authorize?code=${userCode}`, expiresAt: expiresAt.toISOString(), interval: 2 };
    })
    .get("/api/cli/device-authorization", async ({ request, set }) => {
      const address = clientAddress(request, trustedProxyHops);
      const limit = deviceAuthCounter.take(`code:${address}`, 20, MINUTE_MS);
      if (!limit.allowed) return addressLimited(set, "DEVICE_LOGIN_LIMIT", limit.retryAfterSeconds);
      const caller = await resolveCaller(request);
      if (!caller || caller.via !== "session") { set.status = 401; return { error: "Sign in to review this device request." }; }
      const code = new URL(request.url).searchParams.get("code")?.replace(/[^a-z0-9]/gi, "").toUpperCase() ?? "";
      if (!/^[A-HJ-NP-Z2-9]{8}$/.test(code)) { set.status = 404; return { error: "This sign-in request is invalid or expired." }; }
      const [authorization] = await db.select().from(cliDeviceAuthorizations).where(eq(cliDeviceAuthorizations.userCodeHash, createHash("sha256").update(code).digest("hex")));
      if (!authorization || authorization.status !== "pending" || authorization.expiresAt <= new Date(limitClock())) { set.status = 404; return { error: "This sign-in request is invalid or expired." }; }
      set.headers["cache-control"] = "no-store";
      set.headers["referrer-policy"] = "no-referrer";
      const [approvingUser] = await db.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, caller.userId));
      if (!approvingUser) { set.status = 401; return { error: "Sign in to review this device request." }; }
      return { hostname: authorization.hostname, account: approvingUser, access: "account-wide", expiresAt: authorization.expiresAt.toISOString() };
    })
    .post("/api/cli/device-authorization/decision", async ({ request, set }) => {
      const caller = await resolveCaller(request);
      if (!caller || caller.via !== "session") { set.status = 401; return { error: "Sign in to review this device request." }; }
      const origin = request.headers.get("origin");
      const allowedOrigin = (Bun.env.WEB_ORIGIN ?? "http://localhost:5173").replace(/\/$/, "");
      if (!origin || origin.replace(/\/$/, "") !== allowedOrigin) { set.status = 403; return { error: "Request origin is not allowed." }; }
      const body = await request.json().catch(() => null) as { code?: unknown; decision?: unknown } | null;
      const code = typeof body?.code === "string" ? body.code.replace(/[^a-z0-9]/gi, "").toUpperCase() : "";
      if (!/^[A-HJ-NP-Z2-9]{8}$/.test(code) || !["approve", "deny"].includes(String(body?.decision))) { set.status = 404; return { error: "This sign-in request is invalid or expired." }; }
      const address = clientAddress(request, trustedProxyHops);
      const limit = deviceAuthCounter.take(`decision:${address}`, 20, MINUTE_MS);
      if (!limit.allowed) return addressLimited(set, "DEVICE_LOGIN_LIMIT", limit.retryAfterSeconds);
      const [authorization] = await db.update(cliDeviceAuthorizations).set({ status: body!.decision === "approve" ? "approved" : "denied", userId: caller.userId })
        .where(and(eq(cliDeviceAuthorizations.userCodeHash, createHash("sha256").update(code).digest("hex")), eq(cliDeviceAuthorizations.status, "pending"), gt(cliDeviceAuthorizations.expiresAt, new Date(limitClock())))).returning({ id: cliDeviceAuthorizations.id });
      if (!authorization) { set.status = 404; return { error: "This sign-in request is invalid, expired, or already used." }; }
      set.headers["cache-control"] = "no-store";
      return { status: body!.decision === "approve" ? "approved" : "denied" };
    })
    .post("/api/cli/device-authorization/poll", async ({ request, set }) => {
      const address = clientAddress(request, trustedProxyHops);
      const body = await request.json().catch(() => null) as { deviceSecret?: unknown } | null;
      if (typeof body?.deviceSecret !== "string" || body.deviceSecret.length > 100) { set.status = 400; return { error: "Invalid device request." }; }
      const secretHash = createHash("sha256").update(body.deviceSecret).digest("hex");
      const requestLimit = deviceAuthCounter.take(`poll:${secretHash}`, 120, MINUTE_MS);
      const addressLimit = deviceAuthCounter.take(`poll-address:${address}`, 600, MINUTE_MS);
      if (!requestLimit.allowed) return addressLimited(set, "DEVICE_LOGIN_LIMIT", requestLimit.retryAfterSeconds);
      if (!addressLimit.allowed) return addressLimited(set, "DEVICE_LOGIN_LIMIT", addressLimit.retryAfterSeconds);
      const [authorization] = await db.select({ status: cliDeviceAuthorizations.status, expiresAt: cliDeviceAuthorizations.expiresAt }).from(cliDeviceAuthorizations).where(eq(cliDeviceAuthorizations.deviceSecretHash, secretHash));
      if (!authorization) { set.status = 404; return { error: "This sign-in request is invalid or expired." }; }
      set.headers["cache-control"] = "no-store";
      return { status: authorization.expiresAt <= new Date(limitClock()) ? "expired" : authorization.status };
    })
    .post("/api/cli/device-authorization/cancel", async ({ request, set }) => {
      const body = await request.json().catch(() => null) as { deviceSecret?: unknown } | null;
      if (typeof body?.deviceSecret !== "string" || body.deviceSecret.length > 100) { set.status = 400; return { error: "Invalid device request." }; }
      const secretHash = createHash("sha256").update(body.deviceSecret).digest("hex");
      const result = await db.transaction(async (transaction) => {
        const [candidate] = await transaction.select({ userId: cliDeviceAuthorizations.userId, deviceId: cliDeviceAuthorizations.deviceId })
          .from(cliDeviceAuthorizations).where(eq(cliDeviceAuthorizations.deviceSecretHash, secretHash));
        if (!candidate?.userId) {
          const [cancelled] = await transaction.update(cliDeviceAuthorizations).set({ status: "cancelled" })
            .where(and(eq(cliDeviceAuthorizations.deviceSecretHash, secretHash), eq(cliDeviceAuthorizations.status, "pending"))).returning({ id: cliDeviceAuthorizations.id });
          if (cancelled) return "cancelled";
          const [authorization] = await transaction.select({ status: cliDeviceAuthorizations.status }).from(cliDeviceAuthorizations).where(eq(cliDeviceAuthorizations.deviceSecretHash, secretHash));
          return authorization?.status === "cancelled" ? "cancelled" : authorization?.status === "completed" ? "completed" : null;
        }
        // Exchange and finalize use this same device lifecycle lock. Cancellation therefore wins
        // before finalize, or reports that finalize already committed; it cannot revoke the old token.
        await lockCliDeviceLifecycle(transaction as unknown as Database, candidate.userId, candidate.deviceId);
        const [authorization] = await transaction.select().from(cliDeviceAuthorizations)
          .where(eq(cliDeviceAuthorizations.deviceSecretHash, secretHash)).for("update");
        if (!authorization) return null;
        if (authorization.status === "completed") return "completed";
        if (authorization.status === "cancelled") return "cancelled";
        if (!["pending", "approved", "exchanged"].includes(authorization.status)) return null;
        if (authorization.tokenId) {
          await transaction.update(apiTokens).set({ revokedAt: new Date(limitClock()) })
            .where(and(eq(apiTokens.id, authorization.tokenId), isNull(apiTokens.revokedAt)));
        }
        await transaction.update(cliDeviceAuthorizations).set({ status: "cancelled" }).where(eq(cliDeviceAuthorizations.id, authorization.id));
        return "cancelled";
      });
      if (!result) { set.status = 409; return { error: "This sign-in request is no longer cancellable." }; }
      set.headers["cache-control"] = "no-store";
      return { status: result };
    })
    .post("/api/cli/device-authorization/exchange", async ({ request, set }) => {
      const body = await request.json().catch(() => null) as { deviceSecret?: unknown } | null;
      if (typeof body?.deviceSecret !== "string" || body.deviceSecret.length > 100) { set.status = 400; return { error: "Invalid device request." }; }
      const secretHash = createHash("sha256").update(body.deviceSecret).digest("hex");
      const result = await db.transaction(async (transaction) => {
        const [candidate] = await transaction.select({ userId: cliDeviceAuthorizations.userId, deviceId: cliDeviceAuthorizations.deviceId })
          .from(cliDeviceAuthorizations).where(eq(cliDeviceAuthorizations.deviceSecretHash, secretHash));
        if (!candidate?.userId) return null;
        await lockCliDeviceLifecycle(transaction as unknown as Database, candidate.userId, candidate.deviceId);
        const [authorization] = await transaction.select().from(cliDeviceAuthorizations).where(eq(cliDeviceAuthorizations.deviceSecretHash, secretHash)).for("update");
        if (!authorization || authorization.status !== "approved" || authorization.expiresAt <= new Date(limitClock()) || !authorization.userId) return null;
        const [device] = await transaction.select({ isAuthorizedAfterRevocation: sql<boolean>`(${cliDevices.revokedAt} is null or ${cliDeviceAuthorizations.createdAt} > ${cliDevices.revokedAt})` })
          .from(cliDeviceAuthorizations).leftJoin(cliDevices, and(eq(cliDevices.ownerId, authorization.userId), eq(cliDevices.deviceId, authorization.deviceId)))
          .where(eq(cliDeviceAuthorizations.id, authorization.id));
        if (!device?.isAuthorizedAfterRevocation) return null;
        const credential = await mintApiToken(transaction, { userId: authorization.userId, name: `CLI @ ${authorization.hostname}`, description: "Signed in with weft login", expiresAt: new Date(limitClock() + CLI_DEVICE_INACTIVITY_MS), cliDeviceId: authorization.deviceId });
        await transaction.update(cliDeviceAuthorizations).set({ status: "exchanged", tokenId: credential.id }).where(eq(cliDeviceAuthorizations.id, authorization.id));
        return { token: credential.token, exchangeId: authorization.id };
      });
      if (!result) { set.status = 409; return { error: "This sign-in request is not approved, has expired, or was already exchanged." }; }
      set.headers["cache-control"] = "no-store";
      set.headers["pragma"] = "no-cache";
      return result;
    })
    // Rotate only enrolled device credentials. The old credential remains usable until
    // the client has atomically installed the new one and calls finalize.
    .post("/api/cli/device-credentials/renew", async ({ request, set }) => {
      const caller = await resolveCaller(request);
      if (!caller?.apiTokenId || caller.via !== "token") { set.status = 401; return { error: "Sign in with an enrolled CLI device to renew it." }; }
      const now = limitClock();
      const result = await db.transaction(async (transaction) => {
        const [candidate] = await transaction.select({ ownerId: cliDevices.ownerId, deviceId: cliDevices.deviceId }).from(cliDevices)
          .where(and(eq(cliDevices.tokenId, caller.apiTokenId!), eq(cliDevices.ownerId, caller.userId)));
        if (!candidate) return { status: "legacy" as const };
        await lockCliDeviceLifecycle(transaction as unknown as Database, candidate.ownerId, candidate.deviceId);
        const [device] = await transaction.select({ ownerId: cliDevices.ownerId, deviceId: cliDevices.deviceId, hostname: cliDevices.hostname, createdAt: apiTokens.createdAt, revokedAt: cliDevices.revokedAt })
          .from(cliDevices).innerJoin(apiTokens, eq(apiTokens.id, cliDevices.tokenId))
          .where(and(eq(cliDevices.tokenId, caller.apiTokenId!), eq(cliDevices.ownerId, caller.userId))).for("update", { of: cliDevices });
        if (!device) return { status: "legacy" as const };
        if (device.revokedAt) return { status: "revoked" as const };
        if (device.createdAt.getTime() > now - CLI_DEVICE_ROTATION_INTERVAL_MS) return { status: "current" as const };
        const [pending] = await transaction.select({ id: cliDeviceAuthorizations.id }).from(cliDeviceAuthorizations)
          .where(and(eq(cliDeviceAuthorizations.deviceId, device.deviceId), eq(cliDeviceAuthorizations.status, "rotating"), gt(cliDeviceAuthorizations.expiresAt, new Date(now)))).limit(1);
        if (pending) return { status: "pending" as const };
        const credential = await mintApiToken(transaction, {
          userId: caller.userId, name: `CLI @ ${device.hostname}`, description: "Signed in with weft login",
          expiresAt: new Date(now + CLI_DEVICE_INACTIVITY_MS), cliDeviceId: device.deviceId,
        });
        const exchangeId = crypto.randomUUID();
        const marker = () => createHash("sha256").update(crypto.randomUUID()).digest("hex");
        await transaction.insert(cliDeviceAuthorizations).values({
          id: exchangeId, deviceId: device.deviceId, hostname: device.hostname, userId: caller.userId,
          tokenId: credential.id, previousTokenId: caller.apiTokenId, deviceSecretHash: marker(), userCodeHash: marker(), status: "rotating",
          // Limit abandoned exchanges while allowing a saved replacement to finalize later.
          expiresAt: new Date(now + 10 * MINUTE_MS),
        });
        return { status: "rotated" as const, token: credential.token, exchangeId };
      });
      if (result.status === "revoked") { set.status = 401; return { error: "CLI device was revoked. Run `weft login` to sign in again." }; }
      set.headers["cache-control"] = "no-store";
      set.headers.pragma = "no-cache";
      return result;
    })
    .post("/api/cli/device-authorization/finalize", async ({ request, set }) => {
      const bearer = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
      if (!bearer) { set.status = 401; return { error: "The new CLI credential is not valid." }; }
      const body = await request.json().catch(() => null) as { exchangeId?: unknown } | null;
      if (typeof body?.exchangeId !== "string") { set.status = 400; return { error: "Invalid exchange." }; }
      const exchangeId = body.exchangeId;
      const now = new Date(limitClock());
      const [exchange] = await db.select({ status: cliDeviceAuthorizations.status, expiresAt: cliDeviceAuthorizations.expiresAt }).from(cliDeviceAuthorizations).where(eq(cliDeviceAuthorizations.id, exchangeId));
      if (exchange && exchange.status !== "completed" && exchange.expiresAt <= now) {
        await expireCliDeviceAuthorizations(db, now, exchangeId);
        set.status = 410;
        return { error: "This sign-in exchange expired before it was finalized. Run `weft login` to start again." };
      }
      const tokenHash = createHash("sha256").update(bearer).digest("hex");
      const [credential] = await db.select({ id: apiTokens.id, userId: apiTokens.userId, daemonOnly: apiTokens.daemonOnly, revokedAt: apiTokens.revokedAt, expiresAt: apiTokens.expiresAt })
        .from(apiTokens).where(eq(apiTokens.tokenHash, tokenHash));
      if (!credential || credential.daemonOnly || credential.revokedAt || (credential.expiresAt && credential.expiresAt <= new Date(limitClock()))) { set.status = 401; return { error: "The new CLI credential is not valid." }; }
      const tokenId = credential.id;
      const finalized = await db.transaction(async (transaction) => {
        const [candidate] = await transaction.select({ userId: cliDeviceAuthorizations.userId, deviceId: cliDeviceAuthorizations.deviceId })
          .from(cliDeviceAuthorizations).where(and(eq(cliDeviceAuthorizations.id, exchangeId), eq(cliDeviceAuthorizations.tokenId, tokenId)));
        if (!candidate?.userId || candidate.userId !== credential.userId) return false;
        await lockCliDeviceLifecycle(transaction as unknown as Database, candidate.userId, candidate.deviceId);
        const [authorization] = await transaction.select().from(cliDeviceAuthorizations).where(and(eq(cliDeviceAuthorizations.id, exchangeId), eq(cliDeviceAuthorizations.tokenId, tokenId), inArray(cliDeviceAuthorizations.status, ["exchanged", "rotating", "completed"]))).for("update");
        if (!authorization?.userId) return false;
        if (authorization.status !== "completed" && authorization.expiresAt <= new Date(limitClock())) {
          await transaction.update(apiTokens).set({ revokedAt: new Date(limitClock()) })
            .where(and(eq(apiTokens.id, tokenId), isNull(apiTokens.revokedAt)));
          await transaction.update(cliDeviceAuthorizations).set({ status: "expired" }).where(eq(cliDeviceAuthorizations.id, authorization.id));
          return "expired" as const;
        }
        const [deviceState] = await transaction.select({ tokenId: cliDevices.tokenId, revokedAt: cliDevices.revokedAt,
          isAuthorizedAfterRevocation: sql<boolean>`(${cliDevices.revokedAt} is null or ${cliDeviceAuthorizations.createdAt} > ${cliDevices.revokedAt})`,
        }).from(cliDevices).innerJoin(cliDeviceAuthorizations, eq(cliDeviceAuthorizations.id, authorization.id))
          .where(and(eq(cliDevices.deviceId, authorization.deviceId), eq(cliDevices.ownerId, authorization.userId))).for("update", { of: cliDevices });
        if (deviceState && !deviceState.isAuthorizedAfterRevocation) return false;
        if (authorization.status === "completed") {
          return deviceState?.tokenId === tokenId && !deviceState.revokedAt;
        }
        if (authorization.status === "rotating") {
          const prior = deviceState;
          if (!prior || prior.tokenId !== authorization.previousTokenId) return false;
          await transaction.update(apiTokens).set({ cliDeviceId: authorization.deviceId }).where(eq(apiTokens.id, tokenId));
          await transaction.update(cliDevices).set({ tokenId, hostname: authorization.hostname, lastUsedAt: new Date(limitClock()), revokedAt: null }).where(and(eq(cliDevices.deviceId, authorization.deviceId), eq(cliDevices.ownerId, authorization.userId)));
          if (prior.tokenId !== tokenId) await transaction.update(apiTokens).set({ revokedAt: new Date(limitClock()) }).where(and(eq(apiTokens.id, prior.tokenId), isNull(apiTokens.revokedAt)));
          await transaction.update(cliDeviceAuthorizations).set({ status: "completed" }).where(eq(cliDeviceAuthorizations.id, authorization.id));
          return true;
        }
        const [prior] = await transaction.select({ tokenId: cliDevices.tokenId }).from(cliDevices).where(and(eq(cliDevices.deviceId, authorization.deviceId), eq(cliDevices.ownerId, authorization.userId)));
        await transaction.update(apiTokens).set({ cliDeviceId: authorization.deviceId }).where(eq(apiTokens.id, tokenId));
        await transaction.insert(cliDevices).values({ deviceId: authorization.deviceId, ownerId: authorization.userId, hostname: authorization.hostname, tokenId, lastUsedAt: new Date(limitClock()), revokedAt: null })
          .onConflictDoUpdate({ target: [cliDevices.ownerId, cliDevices.deviceId], set: { hostname: authorization.hostname, tokenId, lastUsedAt: new Date(limitClock()), revokedAt: null } });
        if (prior && prior.tokenId !== tokenId) await transaction.update(apiTokens).set({ revokedAt: new Date(limitClock()) }).where(and(eq(apiTokens.id, prior.tokenId), isNull(apiTokens.revokedAt)));
        await transaction.update(cliDeviceAuthorizations).set({ status: "completed" }).where(eq(cliDeviceAuthorizations.id, authorization.id));
        return true;
      });
      if (finalized === "expired") { set.status = 410; return { error: "This sign-in exchange expired before it was finalized. Run `weft login` to start again." }; }
      if (!finalized) { set.status = 409; return { error: "This exchange is invalid or already completed." }; }
      set.headers["cache-control"] = "no-store";
      return { status: "completed" };
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
      return { title: page.title, content: publicContent(sanitizeWrittenDocument(page.content).document) };
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
      if (!owner) { set.status = 401; return { error: "Personal API token expired, revoked, or invalid. Run `weft login` to sign in again." }; }
      const advertised = request.headers.get("x-weft-capabilities")?.split(",").map((capability) => capability.trim()).filter((capability) => capability === "runtime_environment" || capability === "runtime_sandbox");
      try { return await runtimeActions.registerDaemon.handler({ userId: owner.userId, apiTokenId: owner.tokenId }, { ...body, ...(advertised ? { capabilities: advertised } : {}) }); }
      catch (error) { set.status = error instanceof ActionError ? error.status : 400; return { error: error instanceof Error ? error.message : "Daemon registration failed" }; }
    }, { body: runtimeActions.registerDaemon.input })
    .post("/api/daemon/runs/claim", async ({ request, set }) => {
      const caller = await resolveDaemonCaller(request);
      if (!caller?.apiTokenId) { set.status = 401; return { error: "Daemon credential expired or invalid. Run `weft login` to sign in again." }; }
      if (!caller.daemonId) { set.status = 403; return { error: "Daemon is not registered" }; }
      return runtimeDispatch.claimRuns({ userId: caller.userId, daemonId: caller.daemonId }, 20);
    })
    .post("/api/daemon/runs/cancellations", async ({ request, set }) => {
      // A revoked credential gets this one recovery operation so a Daemon that lost its
      // WebSocket can learn about durable revocation stops. It cannot claim, read or start work.
      const bearer = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
      if (!bearer) { set.status = 401; return { error: "Daemon credential expired or invalid." }; }
      const tokenHash = createHash("sha256").update(bearer).digest("hex");
      const [credential] = await db.select({ id: apiTokens.id, userId: apiTokens.userId, revokedAt: apiTokens.revokedAt, daemonOnly: apiTokens.daemonOnly })
        .from(apiTokens).where(eq(apiTokens.tokenHash, tokenHash));
      if (!credential?.daemonOnly || !credential.revokedAt) { set.status = 401; return { error: "Daemon credential expired or invalid." }; }
      const daemon = await daemonForCredential(db, { tokenId: credential.id, userId: credential.userId });
      if (!daemon) { set.status = 401; return { error: "Daemon credential expired or invalid." }; }
      const rows = await db.select({ id: runs.id }).from(runs).innerJoin(runtimes, eq(runtimes.id, runs.runtimeId))
        .where(and(eq(runtimes.daemonId, daemon.id), inArray(runs.status, ["stopping", "cancelled"]), inArray(runs.failureReason, [
          "cli_device_revoked", "daemon_credential_revoked", "cli_device_revoked_unconfirmed", "daemon_credential_revoked_unconfirmed",
        ])));
      return { runIds: rows.map(({ id }) => id) };
    }, { body: Type.Object({}) })
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
      try { await runtimeDispatch.startRun(body.runId, runtime.id, body.session); }
      catch (error) {
        if (error instanceof Error && /sandbox policy changed after this Run was claimed/i.test(error.message)) {
          // Complete through the normal finish path so old Daemons that only know the start endpoint still notify,
          // release capacity and create any required follow-up Run.
          await runtimeDispatch.finishRun(body.runId, { status: "failed", finalOutput: "Sandbox policy changed after this Run was claimed; it was not started.", failureReason: "sandbox_policy_changed" });
        }
        throw error;
      }
      return { ok: true };
    }, { body: Type.Object({ runId: Type.String({ format: "uuid" }), runtimeId: Type.String({ format: "uuid" }), session: Type.Optional(sessionReport) }) })
    // The Daemon asks which of its stable Session folders belong to closed work items; it then removes those folders.
    .post("/api/daemon/session-folders/check", async ({ request, body, set }) => {
      const caller = await resolveDaemonCaller(request); if (!caller?.apiTokenId) { set.status = 401; return { error: "Daemon credential expired or invalid. Run `weft login` to sign in again." }; }
      if (!caller.daemonId) { set.status = 403; return { error: "Daemon is not registered" }; }
      return { retired: await runtimeDispatch.retiredSessionFolders(caller.daemonId, body.folders) };
    }, { body: Type.Object({ folders: Type.Array(Type.String({ maxLength: 64 }), { maxItems: 500 }) }) })
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
      return await runtimeDispatch.finishRun(body.runId, body);
    }, { body: Type.Object({
      runId: Type.String({ format: "uuid" }), status: Type.Union([Type.Literal("completed"), Type.Literal("failed")]), finalOutput: Type.String(), failureReason: Type.Optional(Type.String()),
      // The CLI's own counts; null or absent when the CLI printed none, which keeps the Run's usage unknown.
      usage: Type.Optional(Type.Union([Type.Null(), Type.Object({
        inputTokens: Type.Integer({ minimum: 0 }), outputTokens: Type.Integer({ minimum: 0 }),
        cacheReadTokens: Type.Optional(Type.Integer({ minimum: 0 })), cacheCreationTokens: Type.Optional(Type.Integer({ minimum: 0 })),
        // The cost the CLI itself reported (Claude `total_cost_usd`); absent when it printed none.
        reportedCostUsd: Type.Optional(Type.Union([Type.Null(), Type.Number({ minimum: 0 })])),
      })])),
      model: Type.Optional(Type.Union([Type.Null(), Type.String({ maxLength: 200 })])),
      session: Type.Optional(sessionReport),
    }) })
    .post("/api/daemon/runs/cancel-ack", async ({ request, body, set }) => {
      const caller = await resolveDaemonCaller(request);
      let canAcknowledge = false;
      if (caller?.apiTokenId && caller.daemonId) {
        const [run] = await db.select({ id: runs.id }).from(runs).innerJoin(runtimes, eq(runtimes.id, runs.runtimeId))
          .where(and(eq(runs.id, body.runId), eq(runtimes.daemonId, caller.daemonId)));
        canAcknowledge = Boolean(run);
      } else {
        // Revocation rejects every Daemon request, with one narrowly scoped exception: a process
        // already told to stop may confirm that exact Run and cannot claim, read, or change anything else.
        const bearer = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
        if (bearer) {
          const tokenHash = createHash("sha256").update(bearer).digest("hex");
          const [credential] = await db.select({ id: apiTokens.id, userId: apiTokens.userId, revokedAt: apiTokens.revokedAt, daemonOnly: apiTokens.daemonOnly })
            .from(apiTokens).where(eq(apiTokens.tokenHash, tokenHash));
          const daemon = credential?.revokedAt && credential.daemonOnly
            ? await daemonForCredential(db, { tokenId: credential.id, userId: credential.userId }) : undefined;
          const [run] = daemon ? await db.select({ id: runs.id }).from(runs).innerJoin(runtimes, eq(runtimes.id, runs.runtimeId))
            .where(and(eq(runs.id, body.runId), inArray(runs.status, ["stopping", "cancelled"]), inArray(runs.failureReason, [
              "cli_device_revoked", "daemon_credential_revoked", "cli_device_revoked_unconfirmed", "daemon_credential_revoked_unconfirmed",
            ]), eq(runtimes.daemonId, daemon.id))) : [];
          canAcknowledge = Boolean(run);
        }
      }
      if (!canAcknowledge) { set.status = 401; return { error: "Daemon credential expired or invalid. Run `weft login` to sign in again." }; }
      await runtimeDispatch.acknowledgeCancel(body.runId, body.usage, body.model); return { ok: true };
    }, { body: Type.Object({ runId: Type.String({ format: "uuid" }), usage: Type.Optional(Type.Union([Type.Null(), Type.Object({ inputTokens: Type.Integer({ minimum: 0 }), outputTokens: Type.Integer({ minimum: 0 }), cacheReadTokens: Type.Optional(Type.Integer({ minimum: 0 })), cacheCreationTokens: Type.Optional(Type.Integer({ minimum: 0 })), reportedCostUsd: Type.Optional(Type.Union([Type.Null(), Type.Number({ minimum: 0 })])) })])), model: Type.Optional(Type.Union([Type.Null(), Type.String({ maxLength: 200 })])) }) })
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
    .get("/api/config", () => ({ defaultLocale, minPasswordLength, emailEnabled: mail !== null, integrationsEnabled: integrations, outboundWebhooksEnabled: outboundWebhooks, ai: aiSwitch }))
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
        // Converter work is charged to the user (a token is only a sub-limit of its user, so many tokens are still one caller); a caller without a user is keyed by address and workspace.
        const bodyWorkspace = (body as { workspaceId?: string } | null)?.workspaceId ?? "";
        const converterKey = caller.userId ? `user:${caller.userId}` : `ip:${clientAddress(request, Number(Bun.env.TRUSTED_PROXY_HOPS ?? 0))}:${bodyWorkspace}`;
        const executeAction = () => withWrittenFormKey(converterKey, () => (action.handler as (context: ActionContext, input: unknown) => Promise<unknown>)(caller, body), (caller as { apiTokenId?: string }).apiTokenId);
        let result: unknown;
        if (caller.source === "agent" && caller.agent && action.kind === "read") {
          const guarded = await withAgentRunProjectAuthorization(db, caller.agent.runId, async (state) => {
            if (!state.active) return { kind: "inactive" as const };
            if (!state.allowed) return { kind: "access_revoked" as const };
            return { kind: "result" as const, result: await executeAction() };
          });
          if (guarded.kind === "inactive") { set.status = 409; return { error: "This Agent Run is no longer active." }; }
          if (guarded.kind === "access_revoked") { set.status = 403; return { error: "The Originator or Runtime owner no longer has Project write access, or the Runtime is unshared, so this Agent Run cannot continue." }; }
          result = guarded.result;
        } else if (caller.source === "agent" && caller.agent && action.kind === "write") {
          const guarded = await withAgentRunProjectAuthorization(db, caller.agent.runId, async (state) => {
            if (!state.active) return { kind: "inactive" as const };
            if (!state.allowed || !state.run) return { kind: "access_revoked" as const };
            if (state.run.runtimeEnvironmentSecrets) {
              let secrets: string[] = [];
              let snapshotUnreadable = false;
              try { secrets = Object.values(JSON.parse(openSecret(state.run.runtimeEnvironmentSecrets)) as Record<string, string>); }
              catch { snapshotUnreadable = true; }
              if (snapshotUnreadable || containsRuntimeSecretValue(body, secrets)) return { kind: "blocked" as const, run: state.run };
            }
            // Authorization locks cover only Runtime/Agent/Project grants. The guard intentionally holds no Run lock
            // while an action uses the global DB connection and may create same-work-item follow-up Runs.
            return { kind: "result" as const, result: await executeAction() };
          });
          if (guarded.kind === "inactive") { set.status = 409; return { error: "This Agent Run is no longer active." }; }
          if (guarded.kind === "access_revoked") { set.status = 403; return { error: "The Originator or Runtime owner no longer has Project write access, or the Runtime is unshared, so this Agent Run cannot continue." }; }
          if (guarded.kind === "blocked") {
            const [runtime] = guarded.run.runtimeId ? await db.select({ ownerId: runtimes.ownerId }).from(runtimes).where(eq(runtimes.id, guarded.run.runtimeId)) : [];
            await recordSecretOutputBlockedNotifications(db, { workspaceId: guarded.run.workspaceId, runId: caller.agent.runId, actorId: caller.agent.agentUserId, recipientIds: [caller.agent.originatorId, ...(runtime ? [runtime.ownerId] : [])] });
            set.status = 400;
            return { error: "Write withheld because it contains a configured Runtime secret. Remove or replace the value and retry.", code: "runtime_secret_output" };
          }
          result = guarded.result;
        } else result = await executeAction();
        if (action.kind === "write") await publishChange(db, bus, body, result);
        return result;
      } catch (error) {
        if (error instanceof AgentAccessDeniedError) {
          const [item] = await db.select({ id: workItems.id, workspaceId: workItems.workspaceId, projectId: workItems.projectId }).from(workItems).where(eq(workItems.id, error.workItemId));
          if (item) {
            const note = `${error.message} This request did not start a Run.`;
            await db.insert(comments).values({ workspaceId: item.workspaceId, projectId: item.projectId, workItemId: item.id, authorId: caller.userId,
              body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: note }] }] }, bodyMarkdown: note, bodyText: note });
          }
          set.status = error.status; return { error: error.message };
        }
        if (error instanceof ActionError) { set.status = error.status; if (error.retryAfter) set.headers["retry-after"] = String(error.retryAfter); return { error: error.message, ...(error.code ? { code: error.code } : {}), ...(error.details ? { details: error.details } : {}) }; }
        throw error;
      }
    }, { body: action.input });
  }
  registerEventRoutes(app, { db, resolveCaller, bus });
  registerAiRoutes(app, { enabled: aiSwitch.enabled, db, resolveCaller, bus, model: aiModel, requestsPerMinute: aiOptions.aiRequestsPerMinute, assistRequestsPerMinute: aiOptions.aiAssistRequestsPerMinute, assistNow: aiOptions.aiAssistNow, env: { ...process.env, ...aiOptions.aiEnv, DEFAULT_LANGUAGE: configuredLanguage } });
  // Connected Daemons are told about queued work and cancels within seconds, not only when their next heartbeat arrives.
  const daemonSockets = new Map<string, { socket: { send: (data: string) => unknown }; daemonId: string }>();
  let signalTimer: ReturnType<typeof setInterval> | undefined;
  const traceDaemon = (message: string) => { if (Bun.env.WEFT_DAEMON_TRACE === "1") console.log(`[daemon trace] ${message}`); };
  /** New Daemons authenticate in the handshake header. Query credentials remain accepted for already-installed Daemon versions. */
  const daemonSocketToken = (socket: { data: { headers?: Record<string, string | undefined>; query?: Record<string, string> } }) => {
    const authorization = socket.data.headers?.authorization;
    if (authorization !== undefined) return authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? null;
    const legacyToken = socket.data.query?.token;
    return typeof legacyToken === "string" ? legacyToken : null;
  };
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
      const token = daemonSocketToken(socket);
      if (!token) { socket.close(1008, "Daemon credential expired or invalid. Run `weft login` to sign in again."); return; }
      const caller = await tokens.authenticateDaemonToken(token);
      if (!caller) { socket.close(1008, "Unauthenticated"); return; }
    },
    message: async (socket, message) => {
      traceDaemon(`websocket message ${typeof message === "string" ? message : JSON.stringify(message)}`);
      if (message !== "heartbeat" && !(message && typeof message === "object" && (message as { type?: unknown }).type === "heartbeat")) {
        socket.close(1003, "Unsupported daemon frame"); return;
      }
      const token = daemonSocketToken(socket);
      const caller = token ? await tokens.authenticateDaemonToken(token) : null;
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
      // The Daemon names the Runtimes it holds; ids that are not well-formed cannot be Runtimes and are not looked up.
      const named = (message as { runtimeIds?: unknown } | null)?.runtimeIds;
      const runtimeIds = Array.isArray(named) ? named.filter((id): id is string => typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) : [];
      const { goneRuntimeIds } = await runtimeActions.heartbeat({ userId: caller.userId }, daemon.id, runtimeIds);
      socket.send(JSON.stringify({ type: "heartbeat_ack", at: new Date().toISOString(), goneRuntimeIds }));
      daemonSockets.set(socket.id, { socket, daemonId: daemon.id });
      signalTimer ??= setInterval(() => { for (const [id, entry] of daemonSockets) void signalDaemon(entry.socket, entry.daemonId).catch(() => daemonSockets.delete(id)); if (!daemonSockets.size && signalTimer) { clearInterval(signalTimer); signalTimer = undefined; } }, 2_000).unref();
      await signalDaemon(socket, daemon.id);
    },
    close: (socket) => { traceDaemon("websocket closed"); daemonSockets.delete(socket.id); },
  });
  return app;
}
