import { afterAll, expect, test } from "bun:test";
import { createDatabase } from "@weft/db";
import { createMailerFromEnv } from "@weft/actions";
import { withRollback } from "../../../packages/db/src/test-helpers";
import { startFakeGraph, type FakeGraph } from "../../../packages/actions/test/graph-server";
import { createApp } from "../src/app";

const { client, db } = createDatabase();
const fakes: FakeGraph[] = [];
// Tests run concurrently and share nothing, so the fake server closes only when the file is done.
afterAll(() => { for (const fake of fakes.splice(0)) fake.close(); });
afterAll(async () => client.end());

const password = "a-secure-password";
const webOrigin = process.env.WEB_ORIGIN ?? "http://localhost:5173";

function graphMailer() {
  const fake = startFakeGraph();
  fakes.push(fake);
  const mailer = createMailerFromEnv(
    {
      MAIL_TRANSPORT: "graph",
      GRAPH_MAIL_TENANT_ID: "tenant-123",
      GRAPH_MAIL_CLIENT_ID: "client-abc",
      GRAPH_MAIL_CLIENT_SECRET: "graph-client-secret-DO-NOT-LEAK",
      GRAPH_MAIL_SENDER: "noreply@weft.test",
    },
    { authorityUrl: fake.authorityUrl, graphUrl: fake.graphUrl },
  );
  return { fake, mailer };
}

/** Polls until the fake Graph has received `count` sendMail requests; fails after 5 seconds. */
async function waitForSends(fake: FakeGraph, count: number) {
  const deadline = Date.now() + 5_000;
  while (fake.sendRequests.length < count) {
    if (Date.now() > deadline) throw new Error(`expected ${count} sendMail requests, got ${fake.sendRequests.length}`);
    await Bun.sleep(10);
  }
  return fake.sendRequests;
}

/** The text of one sendMail body as Graph receives it, with the recipient and subject. */
function sentMessage(body: unknown) {
  const message = (body as { message: { subject: string; body: { content: string }; toRecipients: Array<{ emailAddress: { address: string } }> } }).message;
  return { to: message.toRecipients.map((recipient) => recipient.emailAddress.address), subject: message.subject, text: message.body.content };
}

test.concurrent("with MAIL_TRANSPORT=graph and all four settings, /api/config reports emailEnabled true", async () => {
  await withRollback(db, async (transaction) => {
    const { mailer } = graphMailer();
    const app = createApp(undefined, transaction, undefined, undefined, undefined, undefined, undefined, undefined, mailer);
    expect(await (await app.handle(new Request("http://localhost/api/config"))).json()).toEqual({ defaultLocale: null, minPasswordLength: 10, emailEnabled: true, integrationsEnabled: true, outboundWebhooksEnabled: false, ai: expect.any(Object) });
  });
});

test.concurrent("on a Graph instance, the reset-password email reaches the fake Graph server with one reused token and no Sent Items copy", async () => {
  await withRollback(db, async (transaction) => {
    const { fake, mailer } = graphMailer();
    const app = createApp(undefined, transaction, undefined, undefined, undefined, undefined, undefined, undefined, mailer);
    const json = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const email = `${crypto.randomUUID()}@example.test`;
    expect((await app.handle(new Request("http://localhost/api/auth/sign-up/email", json({ name: "Forgetful", email, password })))).status).toBe(200);
    expect((await app.handle(new Request("http://localhost/api/auth/request-password-reset", json({ email, redirectTo: `${webOrigin}/reset-password` })))).status).toBe(200);

    const [, reset] = await waitForSends(fake, 2);
    expect(reset!.path).toBe("/v1.0/users/noreply@weft.test/sendMail");
    expect(reset!.authorization).toBe("Bearer token-1");
    const sent = sentMessage(reset!.body);
    expect(sent.to).toEqual([email]);
    expect(sent.subject).toBe("Reset your Weft password");
    expect(sent.text).toContain(`callbackURL=${encodeURIComponent(`${webOrigin}/reset-password`)}`);
    expect((reset!.body as { saveToSentItems: boolean }).saveToSentItems).toBe(false);
    expect(fake.tokenRequests).toHaveLength(1);
  });
});
