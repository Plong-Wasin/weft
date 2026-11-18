import { afterAll, expect, spyOn, test } from "bun:test";
import { createMailerFromEnv, type MailDeliveryError } from "../src";
import { startFakeGraph, type FakeGraph } from "./graph-server";
import { startSmtpSink, type SmtpSink } from "./smtp-sink";

// Selection only: every Graph test talks to a fake server on 127.0.0.1, never to Microsoft.
const fakes: FakeGraph[] = [];
const sinks: SmtpSink[] = [];
// Tests run concurrently and share nothing, so servers close only when the file is done.
afterAll(() => {
  for (const fake of fakes.splice(0)) fake.close();
  for (const sink of sinks.splice(0)) sink.close();
});

const graphEnv = {
  MAIL_TRANSPORT: "graph",
  GRAPH_MAIL_TENANT_ID: "tenant-123",
  GRAPH_MAIL_CLIENT_ID: "client-abc",
  GRAPH_MAIL_CLIENT_SECRET: "graph-client-secret-DO-NOT-LEAK",
  GRAPH_MAIL_SENDER: "noreply@weft.test",
};
const smtpEnv = { SMTP_HOST: "smtp.example.test", SMTP_FROM: "Weft <noreply@example.test>" };
const message = { to: "person@example.test", subject: "Hello", text: "Body" };

test.concurrent("unset MAIL_TRANSPORT and MAIL_TRANSPORT=smtp keep the SMTP path", async () => {
  // Unset: no SMTP settings, so email is off exactly as before.
  expect(createMailerFromEnv({})).toBeNull();
  expect(createMailerFromEnv({ MAIL_TRANSPORT: "   " })).toBeNull();

  // Explicit smtp with SMTP settings: the mailer delivers through SMTP, not Graph.
  const sink = startSmtpSink();
  sinks.push(sink);
  const fake = startFakeGraph();
  fakes.push(fake);
  const mailer = createMailerFromEnv({ MAIL_TRANSPORT: "smtp", SMTP_HOST: "127.0.0.1", SMTP_PORT: String(sink.port), SMTP_FROM: "Weft <noreply@weft.test>" });
  expect(mailer).not.toBeNull();
  await mailer!.send(message);
  expect((await sink.waitFor(1))[0]!.to).toEqual([message.to]);
  expect(fake.tokenRequests).toHaveLength(0);
  expect(fake.sendRequests).toHaveLength(0);
});

test.concurrent("MAIL_TRANSPORT=graph with all four settings returns a Graph mailer that sends through Graph", async () => {
  const fake = startFakeGraph();
  fakes.push(fake);
  const mailer = createMailerFromEnv(graphEnv, { authorityUrl: fake.authorityUrl, graphUrl: fake.graphUrl });
  expect(mailer).not.toBeNull();
  await mailer!.send(message);
  expect(fake.tokenRequests).toHaveLength(1);
  expect(fake.sendRequests).toHaveLength(1);
  expect(fake.sendRequests[0]!.path).toBe("/v1.0/users/noreply@weft.test/sendMail");
});

test("MAIL_TRANSPORT=graph with any Graph setting missing returns no mailer, warns once naming the missing variables, and never uses SMTP", () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const env = { ...graphEnv, GRAPH_MAIL_CLIENT_SECRET: "  ", GRAPH_MAIL_SENDER: undefined, ...smtpEnv, SMTP_PORT: "587" };
    expect(createMailerFromEnv(env)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    const text = String(warn.mock.calls[0]![0]);
    expect(text).toContain("GRAPH_MAIL_CLIENT_SECRET");
    expect(text).toContain("GRAPH_MAIL_SENDER");
    expect(text).not.toContain("GRAPH_MAIL_TENANT_ID");
    expect(text).not.toContain("graph-client-secret-DO-NOT-LEAK");
  } finally {
    warn.mockRestore();
  }
});

test("a MAIL_TRANSPORT value other than smtp or graph throws at startup, naming both accepted values", () => {
  for (const value of ["sendgrid", "Graph", "smtps"]) {
    expect(() => createMailerFromEnv({ ...graphEnv, ...smtpEnv, MAIL_TRANSPORT: value })).toThrow(/smtp.*graph|graph.*smtp/);
  }
});

test.concurrent("a Graph failure from the selected transport surfaces as MailDeliveryError without the secret", async () => {
  const fake = startFakeGraph({ tokenStatus: 401, errorMessage: "AADSTS7000215: Invalid client secret graph-client-secret-DO-NOT-LEAK" });
  fakes.push(fake);
  const mailer = createMailerFromEnv(graphEnv, { authorityUrl: fake.authorityUrl, graphUrl: fake.graphUrl })!;
  const error = await mailer.send(message).then(() => null, (failure: MailDeliveryError) => failure);
  expect(error).not.toBeNull();
  expect(error!.message).not.toContain("graph-client-secret-DO-NOT-LEAK");
});
