import nodemailer from "nodemailer";
import type { MailLocale } from "./email-templates";

const mailLocales: readonly MailLocale[] = ["en", "th"];

/** SMTP settings from the environment. Email is on only when SMTP_HOST and SMTP_FROM are both set. */
export interface MailSettings {
  host: string;
  port: number;
  /** true: TLS from the first byte (usually port 465). false: STARTTLS when the server offers it (usually port 587). */
  secure: boolean;
  username?: string;
  password?: string;
  from: string;
}

export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
}

/** Sends one message. Implementations must not put message bodies or tokens into errors. */
export interface Mailer {
  send(message: OutgoingMail): Promise<void>;
}

/** Raised when the SMTP server refuses or cannot be reached. The message names the failure class only, never the content. */
export class MailDeliveryError extends Error {
  constructor(readonly code: string) {
    super(`Email delivery failed: ${code}`);
    this.name = "MailDeliveryError";
  }
}

type Env = Record<string, string | undefined>;

/** Returns the SMTP settings, or null when email is not set up (no SMTP_HOST, or no SMTP_FROM). */
export function mailSettingsFromEnv(env: Env = Bun.env): MailSettings | null {
  const host = env.SMTP_HOST?.trim();
  if (!host) return null;
  const from = env.SMTP_FROM?.trim();
  if (!from) {
    console.warn("SMTP_HOST is set but SMTP_FROM is not; email stays off.");
    return null;
  }
  const secure = (env.SMTP_SECURE ?? "false").trim().toLowerCase() === "true";
  const port = Number(env.SMTP_PORT ?? (secure ? 465 : 587));
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.warn(`Ignoring invalid SMTP_PORT=${env.SMTP_PORT}; email stays off.`);
    return null;
  }
  const username = env.SMTP_USERNAME || undefined;
  const password = env.SMTP_PASSWORD || undefined;
  return { host, port, secure, from, ...(username ? { username } : {}), ...(password ? { password } : {}) };
}

/** Sends through the configured SMTP server. */
export function createSmtpMailer(settings: MailSettings): Mailer {
  const transport = nodemailer.createTransport({
    host: settings.host,
    port: settings.port,
    secure: settings.secure,
    ...(settings.username ? { auth: { user: settings.username, pass: settings.password ?? "" } } : {}),
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
  });
  return {
    async send(message) {
      try {
        await transport.sendMail({ from: settings.from, to: message.to, subject: message.subject, text: message.text });
      } catch (error) {
        const code = typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : "SEND_FAILED";
        throw new MailDeliveryError(code);
      }
    },
  };
}

/** The mailer the process uses, or null when email is off. */
export function createMailerFromEnv(env: Env = Bun.env): Mailer | null {
  const settings = mailSettingsFromEnv(env);
  if (!settings) return null;
  return createSmtpMailer(settings);
}

/** Where email links point for the web app. Mirrors the API's WEB_ORIGIN default. */
export function webOriginFromEnv(env: Env = Bun.env): string {
  return env.WEB_ORIGIN ?? "http://localhost:5173";
}

/** The instance-wide default language (DEFAULT_LANGUAGE), or null when unset or invalid. */
export function instanceLocaleFromEnv(env: Env = Bun.env): MailLocale | null {
  const value = env.DEFAULT_LANGUAGE;
  return mailLocales.find((locale) => locale === value) ?? null;
}
