/**
 * Request clean-up in front of the OAuth provider. MCP clients send an RFC 8707 `resource` and scopes such as `openid`;
 * Weft issues opaque, user-wide tokens, so the provider only ever sees `offline_access`.
 */
const SUPPORTED_SCOPES = new Set(["offline_access"]);

export function keepSupportedScopes(scope: string) {
  return scope.split(/\s+/).filter((name) => SUPPORTED_SCOPES.has(name)).join(" ");
}

/** Drop `resource` and unsupported scopes from OAuth request parameters, in place. */
export function dropUnsupportedOAuthParams(params: URLSearchParams) {
  params.delete("resource");
  const scope = params.get("scope");
  if (scope === null) return;
  const kept = keepSupportedScopes(scope);
  if (kept) params.set("scope", kept); else params.delete("scope");
}

export const isFormBody = (request: Request) => (request.headers.get("content-type") ?? "").toLowerCase().includes("application/x-www-form-urlencoded");

/** Same request with a new body; the stale content-length would make the runtime reject it. */
export function withBody(request: Request, body: BodyInit) {
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  return new Request(request.url, { method: request.method, headers, body });
}

export const MAX_REGISTRATION_BODY = 8 * 1024;
const MAX_REGISTRATION_URI = 2 * 1024;
const MAX_CLIENT_NAME = 100;
const MAX_REDIRECT_URIS = 5;

/**
 * Validate and normalise an anonymous Dynamic Client Registration body. Returns the cleaned payload, or the
 * OAuth error to answer with. Only public clients exist, so an omitted auth method means `none`.
 */
export function cleanRegistration(raw: string): { payload: Record<string, unknown> } | { error: string } {
  if (raw.length > MAX_REGISTRATION_BODY) return { error: "Registration body is limited to 8 KB" };
  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { error: "Registration body must be a JSON object" };
    payload = parsed as Record<string, unknown>;
  } catch {
    return { error: "Registration body must be JSON" };
  }
  if ((payload.token_endpoint_auth_method ?? "none") !== "none" || payload.client_secret) return { error: "Only public OAuth clients are supported" };
  payload.token_endpoint_auth_method = "none";
  if (typeof payload.client_name === "string" && payload.client_name.length > MAX_CLIENT_NAME) return { error: "client_name is limited to 100 characters" };
  if (Array.isArray(payload.redirect_uris) && (payload.redirect_uris.length > MAX_REDIRECT_URIS || payload.redirect_uris.some((uri) => typeof uri === "string" && uri.length > MAX_REGISTRATION_URI))) {
    return { error: "redirect_uris is limited to 5 entries of 2 KB" };
  }
  if (typeof payload.scope === "string") {
    const kept = keepSupportedScopes(payload.scope);
    if (kept) payload.scope = kept; else delete payload.scope;
  }
  return { payload };
}

/**
 * Per-caller and global cap on anonymous client registrations. The caller key never trusts a header the client can set:
 * without trusted proxies every caller shares one bucket; with N trusted proxies it is the N-th entry from the right of
 * x-forwarded-for, which the nearest proxy wrote.
 */
export function createRegistrationLimiter(options: { trustedProxyHops?: number; perCallerPerHour?: number; globalPerHour?: number } = {}) {
  const hops = options.trustedProxyHops ?? 0;
  const perCaller = options.perCallerPerHour ?? 20;
  const global = options.globalPerHour ?? 200;
  const hour = 60 * 60 * 1000;
  const hits = new Map<string, number[]>();
  return {
    /** True when the registration may go ahead; counts it. */
    allow(request: Request, now = Date.now()) {
      for (const [key, times] of hits) {
        const recent = times.filter((time) => now - time < hour);
        if (recent.length) hits.set(key, recent); else hits.delete(key);
      }
      const forwarded = (request.headers.get("x-forwarded-for") ?? "").split(",").map((part) => part.trim()).filter(Boolean);
      const key = hops > 0 ? forwarded[forwarded.length - hops] ?? "direct" : "direct";
      const all = [...hits.values()].reduce((sum, times) => sum + times.length, 0);
      const mine = hits.get(key) ?? [];
      if (mine.length >= perCaller || all >= global) return false;
      hits.set(key, [...mine, now]);
      return true;
    },
  };
}
