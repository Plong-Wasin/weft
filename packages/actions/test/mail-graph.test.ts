import { afterEach, expect, test } from "bun:test";
import { createGraphMailer, GRAPH_AUTHORITY_URL, GRAPH_BASE_URL, GRAPH_REQUEST_TIMEOUT_MS, MailDeliveryError, type GraphMailerOptions } from "../src";
import { startFakeGraph, type FakeGraph, type FakeGraphOptions } from "./graph-server";

// Every test talks only to a fake server on 127.0.0.1. No test calls Microsoft.
const fakes: FakeGraph[] = [];
afterEach(() => { for (const fake of fakes.splice(0)) fake.close(); });

const clientSecret = "graph-client-secret-DO-NOT-LEAK";
const sender = "noreply@weft.test";
const message = { to: "person@example.test", subject: "Reset your password", text: "Open this link: https://weft.test/reset/abc123" };

function fake(options: FakeGraphOptions = {}) {
  const server = startFakeGraph(options);
  fakes.push(server);
  return server;
}

function mailerFor(server: FakeGraph, extra: Partial<GraphMailerOptions> = {}) {
  return createGraphMailer({
    tenantId: "tenant-123",
    clientId: "client-abc",
    clientSecret,
    sender,
    authorityUrl: server.authorityUrl,
    graphUrl: server.graphUrl,
    ...extra,
  });
}

/** Resolves to the MailDeliveryError the send raised, or fails the test when the send succeeds. */
async function failureOf(promise: Promise<void>): Promise<MailDeliveryError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(MailDeliveryError);
    return error as MailDeliveryError;
  }
  throw new Error("expected the send to fail");
}

/** Asserts that an error carries none of the secret, the access token or the message content. */
function expectNoSecrets(error: MailDeliveryError, token?: string) {
  const visible = [error.message, error.code, error.name, String(error)].join("\n");
  expect(visible).not.toContain(clientSecret);
  if (token) expect(visible).not.toContain(token);
  expect(visible).not.toContain("Open this link");
  expect(visible).not.toContain("abc123");
  expect(visible).not.toContain(message.subject);
}

test.serial("a send posts to /users/{sender}/sendMail with a bearer token, plain text, one recipient and saveToSentItems false", async () => {
  const server = fake();
  await mailerFor(server).send(message);

  expect(server.tokenRequests).toHaveLength(1);
  expect(server.tokenRequests[0]!.path).toBe("/tenant-123/oauth2/v2.0/token");
  expect(server.tokenRequests[0]!.form).toEqual({
    client_id: "client-abc",
    client_secret: clientSecret,
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials",
  });

  expect(server.sendRequests).toHaveLength(1);
  const [sent] = server.sendRequests;
  expect(sent!.path).toBe(`/v1.0/users/${sender}/sendMail`);
  expect(sent!.authorization).toBe(`Bearer ${server.issuedTokens[0]}`);
  expect(sent!.body).toEqual({
    message: {
      subject: message.subject,
      body: { contentType: "Text", content: message.text },
      toRecipients: [{ emailAddress: { address: message.to } }],
    },
    saveToSentItems: false,
  });
});

test.serial("the token is reused across sends and requested again within 60 seconds of its expiry", async () => {
  const server = fake({ tokenExpiresIn: 3600 });
  let clock = 0;
  const mailer = mailerFor(server, { now: () => clock });

  await mailer.send(message);
  clock = 1_000_000;
  await mailer.send(message);
  expect(server.tokenRequests).toHaveLength(1);
  expect(server.sendRequests.map((request) => request.authorization)).toEqual(["Bearer token-1", "Bearer token-1"]);

  // 3600 s lifetime: 59 s before expiry is inside the 60 s margin, so the next send asks again.
  clock = 3_600_000 - 59_000;
  await mailer.send(message);
  expect(server.tokenRequests).toHaveLength(2);
  expect(server.sendRequests.at(-1)!.authorization).toBe("Bearer token-2");

  // The refreshed token (issued at 3541 s, lifetime 3600 s) is reused a second later.
  clock += 1_000;
  await mailer.send(message);
  expect(server.tokenRequests).toHaveLength(2);
});

test.serial("concurrent sends share one in-flight token request", async () => {
  const server = fake({ tokenDelayMs: 100 });
  const mailer = mailerFor(server);

  await Promise.all([mailer.send(message), mailer.send(message), mailer.send(message)]);

  expect(server.tokenRequests).toHaveLength(1);
  expect(server.sendRequests).toHaveLength(3);
  for (const request of server.sendRequests) expect(request.authorization).toBe("Bearer token-1");
});

test.serial("a 401 from sendMail drops the cached token, so the next send asks Microsoft for a new one", async () => {
  const server = fake({ sendStatus: 401, sendErrorCode: "InvalidAuthenticationToken" });
  const mailer = mailerFor(server);
  await failureOf(mailer.send(message));

  server.options.sendStatus = 202;
  await mailer.send(message);
  expect(server.tokenRequests).toHaveLength(2);
  expect(server.sendRequests.at(-1)!.authorization).toBe("Bearer token-2");
});

test.serial("a 401 from sendMail becomes MailDeliveryError with the HTTP status and Graph error code only", async () => {
  const server = fake({ sendStatus: 401, sendErrorCode: "InvalidAuthenticationToken", errorMessage: "Access token has expired. Open this link: https://weft.test/reset/abc123" });
  const error = await failureOf(mailerFor(server).send(message));
  expect(error.code).toBe("HTTP_401:InvalidAuthenticationToken");
  expectNoSecrets(error, server.issuedTokens[0]);
});

test.serial("a 403 from sendMail becomes MailDeliveryError naming the status and Graph error code", async () => {
  const server = fake({ sendStatus: 403, sendErrorCode: "ErrorAccessDenied", errorMessage: `Mailbox not allowed for ${message.text}` });
  const error = await failureOf(mailerFor(server).send(message));
  expect(error.code).toBe("HTTP_403:ErrorAccessDenied");
  expectNoSecrets(error, server.issuedTokens[0]);
});

test.serial("a 429 from sendMail becomes MailDeliveryError naming the status and Graph error code", async () => {
  const server = fake({ sendStatus: 429, sendErrorCode: "TooManyRequests" });
  const error = await failureOf(mailerFor(server).send(message));
  expect(error.code).toBe("HTTP_429:TooManyRequests");
  expectNoSecrets(error, server.issuedTokens[0]);
});

test.serial("a 5xx from sendMail becomes MailDeliveryError naming the status, without a Graph code when none is sent", async () => {
  const server = fake({ sendStatus: 503, sendErrorCode: "", errorMessage: "" });
  const error = await failureOf(mailerFor(server).send(message));
  expect(error.code).toBe("HTTP_503");
  expectNoSecrets(error, server.issuedTokens[0]);
});

test.serial("a rejected client secret at the token endpoint becomes MailDeliveryError naming the OAuth error, never the secret", async () => {
  const server = fake({ tokenStatus: 401, errorMessage: `secret was ${clientSecret}` });
  const error = await failureOf(mailerFor(server).send(message));
  expect(error.code).toBe("TOKEN_HTTP_401:invalid_client");
  expectNoSecrets(error);
  expect(server.sendRequests).toHaveLength(0);
});

test.serial("a connection refused by the server becomes MailDeliveryError with code NETWORK", async () => {
  const server = fake();
  const mailer = mailerFor(server);
  server.close();
  fakes.splice(fakes.indexOf(server), 1);
  const error = await failureOf(mailer.send(message));
  expect(error.code).toBe("NETWORK");
  expectNoSecrets(error);
});

test.serial("a sendMail that hangs past the request timeout becomes MailDeliveryError with code TIMEOUT", async () => {
  const server = fake({ sendDelayMs: 3_000, tokenExpiresIn: 3600 });
  const started = Date.now();
  const error = await failureOf(mailerFor(server, { timeoutMs: 100 }).send(message));
  expect(error.code).toBe("TIMEOUT");
  expect(Date.now() - started).toBeLessThan(2_500);
  expectNoSecrets(error, server.issuedTokens[0]);
});

test.serial("a token request that hangs past the request timeout becomes MailDeliveryError with code TIMEOUT", async () => {
  const server = fake({ tokenDelayMs: 3_000 });
  const error = await failureOf(mailerFor(server, { timeoutMs: 100 }).send(message));
  expect(error.code).toBe("TIMEOUT");
  expectNoSecrets(error);
  expect(server.sendRequests).toHaveLength(0);
});

test.serial("the request timeout is 10 seconds and the Graph endpoints default to Microsoft's commercial cloud", () => {
  expect(GRAPH_REQUEST_TIMEOUT_MS).toBe(10_000);
  expect(GRAPH_AUTHORITY_URL).toBe("https://login.microsoftonline.com");
  expect(GRAPH_BASE_URL).toBe("https://graph.microsoft.com/v1.0");
});
