import { microsoftEntraId, type GenericOAuthConfig, type GenericOAuthUserInfo } from "better-auth/plugins/generic-oauth";
import { APIError } from "better-auth/api";

export type MicrosoftAuthSettings = {
  clientId?: string;
  clientSecret?: string;
  tenantId?: string;
  allowedEmailDomains?: string[];
  discoveryUrl?: string;
};

const tenantGuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

export function microsoftAuthSettings(env: Record<string, string | undefined> = process.env): MicrosoftAuthSettings {
  const rawDomains = env.MICROSOFT_ALLOWED_EMAIL_DOMAINS?.trim();
  return {
    clientId: env.MICROSOFT_CLIENT_ID?.trim() || undefined,
    clientSecret: env.MICROSOFT_CLIENT_SECRET || undefined,
    tenantId: env.MICROSOFT_TENANT_ID?.trim() || undefined,
    allowedEmailDomains: rawDomains ? rawDomains.split(",").map((domain) => domain.trim().replace(/^@/, "").toLowerCase()).filter(Boolean) : undefined,
  };
}

export function microsoftEnabled(settings: MicrosoftAuthSettings): boolean {
  return Boolean(settings.clientId && settings.clientSecret && settings.tenantId && tenantGuid.test(settings.tenantId));
}

function idTokenClaims(idToken: string): Record<string, unknown> {
  const payload = idToken.split(".")[1];
  if (!payload) throw new Error("Microsoft sign-in could not verify your work account. Please try again or contact your Weft administrator.");
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new Error("Microsoft sign-in could not verify your work account. Please try again or contact your Weft administrator.");
  }
}

/** Microsoft Entra uses `oid` within a tenant; including `tid` prevents cross-tenant collisions. */
export function microsoftAccountId(profile: Record<string, unknown>): string {
  const tid = typeof profile.tid === "string" ? profile.tid.toLowerCase() : "";
  const oid = typeof profile.oid === "string" ? profile.oid.toLowerCase() : "";
  if (!tenantGuid.test(tid) || !tenantGuid.test(oid)) throw new APIError("FORBIDDEN", { code: "MICROSOFT_INVALID_IDENTITY", message: "Microsoft did not provide a valid tenant and object identity." });
  return `${tid}:${oid}`;
}

export function microsoftProvider(settings: MicrosoftAuthSettings): GenericOAuthConfig<"microsoft-entra-id"> | null {
  if (!microsoftEnabled(settings)) return null;
  const tenant = settings.tenantId!;
  const builtInMicrosoft = microsoftEntraId({ clientId: settings.clientId!, clientSecret: settings.clientSecret!, tenantId: tenant, scopes: ["openid", "profile", "email"], pkce: true, disableProviderLogout: true });
  const discoveryUrl = settings.discoveryUrl ?? builtInMicrosoft.discoveryUrl;
  return {
    ...builtInMicrosoft,
    discoveryUrl,
    requireIdTokenVerification: true,
    // A custom discovery URL is only injected by the fake-provider test; use its discovered endpoints to avoid network calls.
    ...(settings.discoveryUrl ? { authorizationUrl: undefined, tokenUrl: undefined, userInfoUrl: undefined } : {}),
    accountSubject: ({ profile }) => microsoftAccountId(profile),
    getUserInfo: async (tokens): Promise<GenericOAuthUserInfo | null> => {
      if (!tokens.idToken) return null;
      // Better Auth verifies the ID token against discovery JWKS and nonce before this callback.
      const claims = idTokenClaims(tokens.idToken);
      const tid = typeof claims.tid === "string" ? claims.tid.toLowerCase() : "";
      if (tid !== tenant.toLowerCase()) throw new APIError("FORBIDDEN", { code: "MICROSOFT_WRONG_TENANT", message: "This account belongs to a different company tenant." });
      const email = [claims.email, claims.preferred_username, claims.upn].find((value): value is string => typeof value === "string" && value.includes("@"));
      if (!email) throw new APIError("FORBIDDEN", { code: "MICROSOFT_EMAIL_MISSING", message: "Microsoft did not provide a work email address." });
      const domain = email.slice(email.lastIndexOf("@") + 1).toLowerCase();
      if (settings.allowedEmailDomains?.length && !settings.allowedEmailDomains.includes(domain)) throw new APIError("FORBIDDEN", { code: "MICROSOFT_DOMAIN_NOT_ALLOWED", message: "This email domain is not allowed for this Weft instance." });
      const accountId = microsoftAccountId(claims);
      return {
        id: accountId,
        sub: typeof claims.sub === "string" ? claims.sub : accountId,
        tid,
        oid: claims.oid,
        email,
        emailVerified: claims.email_verified === true,
        name: typeof claims.name === "string" ? claims.name : email,
        image: undefined,
      };
    },
  };
}
