import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { APIError } from "better-auth/api";
import { betterAuth } from "better-auth";
import type { Database } from "@weft/db";
import { accounts, sessions, users, verifications } from "@weft/db";

export function createAuth(db: Database, canSignUp: () => Promise<boolean>) {
  return betterAuth({
    database: drizzleAdapter(db as Parameters<typeof drizzleAdapter>[0], {
      provider: "pg",
      schema: { user: users, session: sessions, account: accounts, verification: verifications },
    }),
    emailAndPassword: { enabled: true, minPasswordLength: 8 },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            if (!(await canSignUp())) {
              throw new APIError("FORBIDDEN", { message: "Open signup is disabled" });
            }
            return { data: user };
          },
        },
      },
    },
    trustedOrigins: [process.env.WEB_ORIGIN ?? "http://localhost:5173"],
    secret: process.env.BETTER_AUTH_SECRET ?? "development-secret-change-before-deploy-32-chars",
    baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:3000",
  });
}
