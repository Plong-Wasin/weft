import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { APIError } from "better-auth/api";
import { betterAuth } from "better-auth";
import { oauthProvider } from "@better-auth/oauth-provider";
import { jwt } from "better-auth/plugins";
import type { Database } from "@weft/db";
import { accounts, jwks, oauthAccessToken, oauthClient, oauthClientAssertion, oauthClientResource, oauthConsent, oauthRefreshToken, oauthResource, requireProductionSecret, sessions, users, verifications } from "@weft/db";

export function createAuth(db: Database, canSignUp: (inviteToken?: string | null) => Promise<boolean>) {
  const webOrigin = process.env.WEB_ORIGIN ?? "http://localhost:5173";
  return betterAuth({
    database: drizzleAdapter(db as Parameters<typeof drizzleAdapter>[0], {
      provider: "pg",
      schema: {
        user: users, session: sessions, account: accounts, verification: verifications,
        jwks, oauthClient, oauthResource, oauthClientResource, oauthRefreshToken, oauthAccessToken, oauthConsent, oauthClientAssertion,
      },
    }),
    emailAndPassword: { enabled: true, minPasswordLength: 8 },
    databaseHooks: {
      user: {
        create: {
          before: async (user, context) => {
            // The invite link's token travels in a header; a valid, unexpired one lets an invitee in when open signup is off.
            if (!(await canSignUp(context?.request?.headers.get("x-weft-invite") ?? context?.headers?.get("x-weft-invite")))) {
              throw new APIError("FORBIDDEN", { message: "Open signup is disabled" });
            }
            return { data: user };
          },
        },
      },
    },
    plugins: [jwt(), oauthProvider({
      scopes: ["offline_access"],
      grantTypes: ["authorization_code", "refresh_token"],
      allowDynamicClientRegistration: true,
      allowUnauthenticatedClientRegistration: true,
      clientRegistrationRequirePKCE: true,
      clientRegistrationDefaultApplicationType: "infer",
      accessTokenExpiresIn: 60 * 60,
      refreshTokenExpiresIn: 30 * 24 * 60 * 60,
      loginPage: `${webOrigin}/oauth/sign-in`,
      consentPage: `${webOrigin}/oauth/consent`,
    })],
    trustedOrigins: [webOrigin],
    secret: requireProductionSecret("BETTER_AUTH_SECRET", process.env.BETTER_AUTH_SECRET, "development-secret-change-before-deploy-32-chars", { minLength: 32 }),
    baseURL: process.env.WEFT_PUBLIC_URL || process.env.BETTER_AUTH_URL || "http://localhost:3000",
  });
}
