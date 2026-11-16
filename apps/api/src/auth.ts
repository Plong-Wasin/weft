import { tryGetCurrentAuthEndpointContext } from "@better-auth/core/context";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { APIError } from "better-auth/api";
import { betterAuth } from "better-auth";
import { oauthProvider } from "@better-auth/oauth-provider";
import { jwt } from "better-auth/plugins";
import { genericOAuth } from "better-auth/plugins/generic-oauth";
import type { Database } from "@weft/db";
import { accounts, jwks, oauthAccessToken, oauthClient, oauthClientAssertion, oauthClientResource, oauthConsent, oauthRefreshToken, oauthResource, requireProductionSecret, sessions, users, verifications } from "@weft/db";
import { resetPasswordEmail, verificationEmail, type Mailer, type MailLocale } from "@weft/actions";
import { eq } from "drizzle-orm";
import { createPasswordPolicy } from "./password-policy";
import { microsoftAuthSettings, microsoftProvider, type MicrosoftAuthSettings } from "./microsoft-auth";

/** Email for account links. Without it (SMTP not set) sign-up and password reset behave as before. */
export interface AccountMail {
  mailer: Mailer;
  /** For people with no saved language: DEFAULT_LANGUAGE, or null for English. */
  defaultLocale: MailLocale | null;
}

const resetPasswordExpiresInSeconds = 60 * 60;

export function minimumPasswordLength(rawMinimum = process.env.MIN_PASSWORD_LENGTH) {
  const parsedMinimum = rawMinimum === undefined || rawMinimum.trim() === "" ? 10 : Number(rawMinimum);
  const valid = Number.isInteger(parsedMinimum) && parsedMinimum >= 1 && parsedMinimum <= 256;
  if (!valid && rawMinimum !== undefined && rawMinimum.trim() !== "") console.warn(`Ignoring invalid MIN_PASSWORD_LENGTH=${rawMinimum}; expected an integer from 1 to 256.`);
  return valid ? parsedMinimum : 10;
}

export type AuthOptions = {
  rangeChecker?: import("./password-policy").RangeChecker;
  online?: boolean;
  minimum?: number;
  microsoft?: MicrosoftAuthSettings;
  passwordSignInEnabled?: boolean;
};

export function createAuth(db: Database, canSignUp: (inviteToken?: string | null) => Promise<boolean>, authOptions: AuthOptions = {}, mail: AccountMail | null = null) {
  const webOrigin = process.env.WEB_ORIGIN ?? "http://localhost:5173";
  const minPasswordLength = authOptions.minimum ?? minimumPasswordLength();
  const onlinePasswordCheck = authOptions.online ?? (process.env.PASSWORD_BREACH_CHECK ?? "on").toLowerCase() !== "off";
  const checkPassword = createPasswordPolicy({ minimum: minPasswordLength, online: onlinePasswordCheck, rangeChecker: authOptions.rangeChecker });
  const microsoft = authOptions.microsoft ?? microsoftAuthSettings();
  const microsoftConfig = microsoftProvider(microsoft);
  const passwordSignInEnabled = authOptions.passwordSignInEnabled ?? (process.env.PASSWORD_SIGN_IN_ENABLED ?? "true").toLowerCase() !== "false";
  /** Sends a link in the recipient's own language. The link itself is the secret, so it is never logged. */
  async function localeFor(email: string): Promise<MailLocale> {
    const [row] = await db.select({ locale: users.locale }).from(users).where(eq(users.email, email));
    return (row?.locale ?? mail?.defaultLocale ?? "en") as MailLocale;
  }
  return betterAuth({
    database: drizzleAdapter(db as Parameters<typeof drizzleAdapter>[0], {
      provider: "pg",
      schema: {
        user: users, session: sessions, account: accounts, verification: verifications,
        jwks, oauthClient, oauthResource, oauthClientResource, oauthRefreshToken, oauthAccessToken, oauthConsent, oauthClientAssertion,
      },
    }),
    emailAndPassword: {
      enabled: passwordSignInEnabled,
      minPasswordLength,
      maxPasswordLength: 256,
      // Finishing a reset through the emailed link also ends a forced reset: the person proved they own the mailbox, so the current password is not needed.
      onPasswordReset: async ({ user }) => {
        await db.update(users).set({ forcePasswordReset: false, securityNotice: null, updatedAt: new Date() }).where(eq(users.id, user.id));
      },
      // Reset links expire after an hour and work once (better-auth consumes the token). Without email the route stays closed, as before.
      ...(mail ? {
        resetPasswordTokenExpiresIn: resetPasswordExpiresInSeconds,
        sendResetPassword: async ({ user, url }) => {
          const message = resetPasswordEmail(await localeFor(user.email), url);
          await mail.mailer.send({ to: user.email, subject: message.subject, text: message.text });
        },
      } : {}),
    },
    account: { accountLinking: { enabled: true, disableImplicitLinking: true, trustedProviders: ["microsoft-entra-id"] } },
    // Verification is sent at sign-up; it does not block signing in, so existing people are not locked out when email is turned on.
    ...(mail ? {
      emailVerification: {
        sendOnSignUp: true,
        sendVerificationEmail: async ({ user, url }) => {
          const message = verificationEmail(await localeFor(user.email), url);
          await mail.mailer.send({ to: user.email, subject: message.subject, text: message.text });
        },
      },
      // Sends run in the background, so a reset request takes the same time whether or not the address exists.
      advanced: { backgroundTasks: { handler: (task: Promise<unknown>) => { void task; } } },
    } : {}),
    databaseHooks: {
      user: {
        create: {
          before: async (user, context) => {
            // The invite link's token travels in a header; a valid, unexpired one lets an invitee in when open signup is off.
            if (!(await canSignUp(context?.request?.headers.get("x-weft-invite") ?? context?.headers?.get("x-weft-invite")))) {
              throw new APIError("FORBIDDEN", { code: "WEFT_INVITE_REQUIRED", message: "Open signup is disabled; ask your Weft administrator for an invite." });
            }
            return { data: user };
          },
        },
      },
    },
    plugins: [
      ...(microsoftConfig ? [genericOAuth({ config: [microsoftConfig] })] : []),
      {
        id: "weft-password-policy",
        init(ctx: { password: { hash(password: string): Promise<string> } }) {
          const originalHash = ctx.password.hash;
          return { context: { password: { ...ctx.password, async hash(password: string) {
            // better-auth also calls hash() as a timing decoy when a sign-in names an unknown email; applying the rules there would answer
            // "too short" for an unknown email and "wrong password" for a known one. The rules guard only the paths that set a password.
            if (!tryGetCurrentAuthEndpointContext()?.path?.startsWith("/sign-in")) await checkPassword(password);
            return originalHash(password);
          } } } };
        },
      },
      jwt(), oauthProvider({
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
      }),
    ],
    // A session can mint a JWT at /token; Weft authenticates with opaque OAuth tokens only, so close it.
    disabledPaths: ["/token"],
    trustedOrigins: [webOrigin],
    secret: requireProductionSecret("BETTER_AUTH_SECRET", process.env.BETTER_AUTH_SECRET, "development-secret-change-before-deploy-32-chars", { minLength: 32 }),
    baseURL: process.env.WEFT_PUBLIC_URL || process.env.BETTER_AUTH_URL || "http://localhost:3000",
  });
}
