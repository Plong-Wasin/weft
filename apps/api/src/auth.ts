import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { APIError } from "better-auth/api";
import { betterAuth } from "better-auth";
import type { Database } from "@weft/db";
import { accounts, requireProductionSecret, sessions, users, verifications } from "@weft/db";

export function createAuth(db: Database, canSignUp: (inviteToken?: string | null) => Promise<boolean>) {
  return betterAuth({
    database: drizzleAdapter(db as Parameters<typeof drizzleAdapter>[0], {
      provider: "pg",
      schema: { user: users, session: sessions, account: accounts, verification: verifications },
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
    trustedOrigins: [process.env.WEB_ORIGIN ?? "http://localhost:5173"],
    secret: requireProductionSecret("BETTER_AUTH_SECRET", process.env.BETTER_AUTH_SECRET, "development-secret-change-before-deploy-32-chars", { minLength: 32 }),
    baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:3000",
  });
}
