import { afterAll, expect, spyOn, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { createDatabase, users, verifications } from "@weft/db";
import { createSmtpMailer } from "@weft/actions";
import { withRollback } from "../../../packages/db/src/test-helpers";
import { startSmtpSink, type SmtpSink } from "../../../packages/actions/test/smtp-sink";
import { createApp } from "../src/app";

const { client, db } = createDatabase();
const sinks: SmtpSink[] = [];
afterAll(() => { for (const sink of sinks.splice(0)) sink.close(); });
afterAll(async () => client.end());

const password = "a-secure-password";
const webOrigin = process.env.WEB_ORIGIN ?? "http://localhost:5173";

function smtp() {
  const sink = startSmtpSink();
  sinks.push(sink);
  return { sink, mailer: createSmtpMailer({ host: "127.0.0.1", port: sink.port, secure: false, from: "Weft <noreply@weft.test>" }) };
}

/** The first link in a message, path and query included. */
function linkIn(text: string, pathPart: string): string {
  const match = text.match(new RegExp(`https?://\\S*${pathPart}\\S*`));
  if (!match) throw new Error(`No link containing ${pathPart} in the message`);
  return match[0];
}

test.concurrent("with SMTP unset, sign-up is unchanged, config says email is off, and reset stays closed as before", async () => {
  await withRollback(db, async (transaction) => {
    const app = createApp(undefined, transaction, undefined, undefined, undefined, undefined, undefined, undefined, null);
    expect(await (await app.handle(new Request("http://localhost/api/config"))).json()).toEqual({ defaultLocale: null, minPasswordLength: 10, emailEnabled: false, integrationsEnabled: true, outboundWebhooksEnabled: false });
    const email = `${crypto.randomUUID()}@example.test`;
    expect((await app.handle(new Request("http://localhost/api/auth/sign-up/email", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "No mail", email, password }) }))).status).toBe(200);
    const reset = await app.handle(new Request("http://localhost/api/auth/request-password-reset", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) }));
    expect(reset.status).toBe(400);
    expect(await reset.json()).toMatchObject({ code: "RESET_PASSWORD_DISABLED" });
  });
});

test.concurrent("sign-up sends a verification email in the instance language, and its link verifies the address", async () => {
  await withRollback(db, async (transaction) => {
    const { sink, mailer } = smtp();
    const app = createApp(undefined, transaction, undefined, undefined, undefined, { defaultLanguage: "th" }, undefined, undefined, mailer);
    expect(await (await app.handle(new Request("http://localhost/api/config"))).json()).toEqual({ defaultLocale: "th", minPasswordLength: 10, emailEnabled: true, integrationsEnabled: true, outboundWebhooksEnabled: false });
    const email = `${crypto.randomUUID()}@example.test`;
    expect((await app.handle(new Request("http://localhost/api/auth/sign-up/email", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Verify me", email, password }) }))).status).toBe(200);

    const [message] = await sink.waitFor(1);
    expect(message!.to).toEqual([email]);
    expect(message!.subject).toBe("ยืนยันอีเมลของคุณสำหรับ Weft");
    const link = linkIn(message!.text, "verify-email\\?token=");
    expect(link).toContain("callbackURL=");

    const verified = await app.handle(new Request(link, { redirect: "manual" }));
    expect(verified.status).toBe(302);
    const [row] = await transaction.select({ emailVerified: users.emailVerified }).from(users).where(eq(users.email, email));
    expect(row?.emailVerified).toBe(true);
  });
});

test.concurrent("password reset: the same answer for known and unknown addresses, one-use and expiring links, and no secret in logs", async () => {
  await withRollback(db, async (transaction) => {
    const { sink, mailer } = smtp();
    const app = createApp(undefined, transaction, undefined, undefined, undefined, undefined, undefined, undefined, mailer);
    const json = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const email = `${crypto.randomUUID()}@example.test`;
    const logged: string[] = [];
    const capture = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
    const spies = [spyOn(console, "log").mockImplementation(capture), spyOn(console, "warn").mockImplementation(capture), spyOn(console, "error").mockImplementation(capture), spyOn(console, "info").mockImplementation(capture)];
    try {
      await app.handle(new Request("http://localhost/api/auth/sign-up/email", json({ name: "Forgetful", email, password })));
      await sink.waitFor(1); // the verification email from sign-up

      const known = await app.handle(new Request("http://localhost/api/auth/request-password-reset", json({ email, redirectTo: `${webOrigin}/reset-password` })));
      const unknown = await app.handle(new Request("http://localhost/api/auth/request-password-reset", json({ email: `nobody-${crypto.randomUUID()}@example.test`, redirectTo: `${webOrigin}/reset-password` })));
      expect(known.status).toBe(200);
      expect(unknown.status).toBe(200);
      expect(await known.json()).toEqual(await unknown.json());

      const messages = await sink.waitFor(2);
      expect(messages).toHaveLength(2);
      const resetMessage = messages[1]!;
      expect(resetMessage.to).toEqual([email]);
      expect(resetMessage.subject).toBe("Reset your Weft password");
      const resetLink = linkIn(resetMessage.text, "reset-password/");
      const token = resetLink.match(/reset-password\/([^?\s]+)/)![1]!;
      expect(resetLink).toContain(`callbackURL=${encodeURIComponent(`${webOrigin}/reset-password`)}`);
      await Bun.sleep(50);
      expect(sink.messages).toHaveLength(2); // the unknown address got nothing

      // Following the link sends the browser to the web app with the token.
      const opened = await app.handle(new Request(resetLink, { redirect: "manual" }));
      expect(opened.status).toBe(302);
      expect(opened.headers.get("location")).toContain(`token=${token}`);

      const reset = await app.handle(new Request("http://localhost/api/auth/reset-password", json({ newPassword: "a-new-password-1", token })));
      expect(reset.status).toBe(200);
      const signInWith = (secret: string) => app.handle(new Request("http://localhost/api/auth/sign-in/email", json({ email, password: secret })));
      expect((await signInWith("a-new-password-1")).status).toBe(200);
      expect((await signInWith(password)).status).toBe(401);

      // The same link does not work twice.
      expect((await app.handle(new Request("http://localhost/api/auth/reset-password", json({ newPassword: "another-password-2", token })))).status).toBe(400);

      // A link past its hour is refused.
      await app.handle(new Request("http://localhost/api/auth/request-password-reset", json({ email })));
      const second = await sink.waitFor(3);
      const expiredToken = linkIn(second[2]!.text, "reset-password/").match(/reset-password\/([^?\s]+)/)![1]!;
      await transaction.update(verifications).set({ expiresAt: new Date(Date.now() - 1000) }).where(and(eq(verifications.identifier, `reset-password:${expiredToken}`)));
      expect((await app.handle(new Request("http://localhost/api/auth/reset-password", json({ newPassword: "expired-password-3", token: expiredToken })))).status).toBe(400);

      // Neither secret appears in anything the server logged.
      for (const secret of [token, expiredToken]) expect(logged.join("\n")).not.toContain(secret);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
