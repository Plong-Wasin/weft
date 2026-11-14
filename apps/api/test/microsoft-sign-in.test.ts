import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createDatabase, schema } from "@weft/db";
import { withRollback } from "../../../packages/db/src/test-helpers";
import { createApp } from "../src/app";

const { client, db } = createDatabase();
afterAll(async () => client.end());

const tenantId = "11111111-1111-4111-8111-111111111111";
const microsoft = { clientId: "fake-client", clientSecret: "fake-secret", tenantId };

async function json(response: Response) {
  return response.json() as Promise<Record<string, unknown>>;
}

function cookieFrom(response: Response) {
  return response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
}

async function fakeOpenIdProvider(callback: (request: Request) => Promise<Response> | Response) {
  const { privateKey, publicKey } = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: Uint8Array.of(1, 0, 1), hash: "SHA-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", publicKey) as JsonWebKey & { kid?: string; alg?: string };
  jwk.kid = "fake-signing-key";
  jwk.alg = "RS256";
  const server = Bun.serve({ port: 0, fetch: callback });
  const issuer = `http://127.0.0.1:${server.port}`;
  return {
    issuer,
    privateKey,
    server,
    settings: { ...microsoft, discoveryUrl: `${issuer}/.well-known/openid-configuration` },
    jwks: () => Response.json({ keys: [jwk] }),
    discovery: () => Response.json({
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/jwks`,
      id_token_signing_alg_values_supported: ["RS256"],
    }),
  };
}

test.concurrent("Microsoft sign-in uses verified OIDC PKCE and state, keeps tenant/object identity stable, requires explicit linking, and applies invite rules without admin access", async () => {
  await withRollback(db, async (transaction) => {
    const codes = new Map<string, { nonce: string; challenge: string; claims: Record<string, unknown> }>();
    let currentClaims: Record<string, unknown> = {};
    const oidc = await fakeOpenIdProvider(async (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/.well-known/openid-configuration") return oidc.discovery();
      if (url.pathname === "/jwks") return oidc.jwks();
      if (url.pathname === "/token") {
        const body = new URLSearchParams(await request.text());
        const flow = codes.get(body.get("code") ?? "");
        const verifier = body.get("code_verifier") ?? "";
        const calculated = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))).toString("base64url");
        if (!flow || calculated !== flow.challenge) return Response.json({ error: "invalid_grant" }, { status: 400 });
        const now = Math.floor(Date.now() / 1000);
        const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "fake-signing-key" })).toString("base64url");
        const payload = Buffer.from(JSON.stringify({ ...flow.claims, nonce: flow.nonce, iss: oidc.issuer, aud: "fake-client", sub: flow.claims.sub, iat: now, exp: now + 300 })).toString("base64url");
        const unsigned = `${header}.${payload}`;
        const signature = Buffer.from(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", oidc.privateKey, new TextEncoder().encode(unsigned))).toString("base64url");
        const idToken = `${unsigned}.${signature}`;
        return Response.json({ access_token: "fake-access-token", token_type: "Bearer", expires_in: 300, id_token: idToken });
      }
      return new Response("Not found", { status: 404 });
    });
    try {
      const app = createApp(undefined, transaction, undefined, undefined, undefined, {}, {}, {}, null, { microsoft: { ...oidc.settings, allowedEmailDomains: ["company.test"] } });
      const signIn = async (claims: Record<string, unknown>, targetApp = app, inviteToken?: string) => {
        currentClaims = claims;
        const start = await targetApp.handle(new Request("http://localhost/api/auth/sign-in/social", {
          method: "POST", headers: { "content-type": "application/json", ...(inviteToken ? { "x-weft-invite": inviteToken } : {}) },
          body: JSON.stringify({ provider: "microsoft-entra-id", callbackURL: "http://localhost:5173/" }),
        }));
        expect(start.status).toBe(200);
        const startBody = await json(start);
        const authorization = new URL(String(startBody.url));
        expect(authorization.origin).toBe(oidc.issuer);
        expect(authorization.searchParams.get("response_type")).toBe("code");
        expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
        expect(authorization.searchParams.get("state")).toBeTruthy();
        expect(authorization.searchParams.get("nonce")).toBeTruthy();
        const code = crypto.randomUUID();
        codes.set(code, { nonce: authorization.searchParams.get("nonce")!, challenge: authorization.searchParams.get("code_challenge")!, claims: currentClaims });
        const callback = new URL(`${authorization.searchParams.get("redirect_uri")}?code=${code}&state=${authorization.searchParams.get("state")}`);
        const finish = await targetApp.handle(new Request(callback, { headers: { cookie: cookieFrom(start) } }));
        return finish;
      };

      const claims = { tid: tenantId, oid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", sub: "entra-subject-1", email: "ada@company.test", email_verified: true, name: "Ada Lovelace" };
      const first = await signIn(claims);
      expect(first.status).toBe(302);
      expect(first.headers.get("location")).toContain("localhost:5173/");
      const firstCookie = cookieFrom(first);
      const firstMe = await json(await app.handle(new Request("http://localhost/api/me", { headers: { cookie: firstCookie } })));
      const firstUser = firstMe.user as Record<string, unknown>;
      expect(firstUser.email).toBe("ada@company.test");
      expect(firstUser.name).toBe("Ada Lovelace");
      expect(firstUser.role).not.toBe("admin");

      const changedEmail = await signIn({ ...claims, email: "ada.new@company.test", sub: "new-subject" });
      const changedMe = await json(await app.handle(new Request("http://localhost/api/me", { headers: { cookie: cookieFrom(changedEmail) } })));
      expect((changedMe.user as Record<string, unknown>).id).toBe(firstUser.id);

      const passwordSignUp = await app.handle(new Request("http://localhost/api/auth/sign-up/email", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Existing Password User", email: "victim@company.test", password: "a-secure-password" }),
      }));
      expect(passwordSignUp.status).toBe(200);
      const passwordCookie = cookieFrom(passwordSignUp);
      const passwordMe = await json(await app.handle(new Request("http://localhost/api/me", { headers: { cookie: passwordCookie } })));
      const passwordUser = passwordMe.user as Record<string, unknown>;
      const forged = await signIn({ ...claims, oid: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", sub: "attacker-subject", email: "victim@company.test" });
      expect(forged.headers.get("set-cookie") ?? "").not.toContain("better-auth.session_token=");
      expect(new URL(forged.headers.get("location")!).searchParams.get("error")).toBe("account_not_linked");
      expect((await transaction.select().from(schema.accounts)).some((account) => account.userId === passwordUser.id && account.providerId === "microsoft-entra-id")).toBe(false);

      const unsignedLink = await app.handle(new Request("http://localhost/api/auth/link-social", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "microsoft-entra-id", callbackURL: "http://localhost:5173/" }),
      }));
      expect(unsignedLink.status).toBe(401);
      const linkStart = await app.handle(new Request("http://localhost/api/auth/link-social", {
        method: "POST", headers: { "content-type": "application/json", cookie: passwordCookie },
        body: JSON.stringify({ provider: "microsoft-entra-id", callbackURL: "http://localhost:5173/" }),
      }));
      expect(linkStart.status).toBe(200);
      const linkUrl = new URL(String((await json(linkStart)).url));
      const linkCode = crypto.randomUUID();
      codes.set(linkCode, { nonce: linkUrl.searchParams.get("nonce")!, challenge: linkUrl.searchParams.get("code_challenge")!, claims: { ...claims, oid: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", sub: "attacker-subject", email: "victim@company.test" } });
      const linkCallback = new URL(`${linkUrl.searchParams.get("redirect_uri")}?code=${linkCode}&state=${linkUrl.searchParams.get("state")}`);
      const linked = await app.handle(new Request(linkCallback, { headers: { cookie: `${cookieFrom(linkStart)}; ${passwordCookie}` } }));
      expect(linked.status).toBe(302);
      expect((await transaction.select().from(schema.accounts)).some((account) => account.userId === passwordUser.id && account.providerId === "microsoft-entra-id")).toBe(true);

      const wrongTenant = await signIn({ ...claims, tid: "22222222-2222-4222-8222-222222222222", oid: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", sub: "other-tenant", email: "staff@company.test" });
      expect(wrongTenant.status).toBe(302);
      expect(new URL(wrongTenant.headers.get("location")!).searchParams.get("error")).toBe("MICROSOFT_WRONG_TENANT");
      const wrongDomain = await signIn({ ...claims, oid: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", sub: "wrong-domain", email: "staff@outside.test" });
      expect(wrongDomain.status).toBe(302);
      expect(new URL(wrongDomain.headers.get("location")!).searchParams.get("error")).toBe("MICROSOFT_DOMAIN_NOT_ALLOWED");

      const [inviteWorkspace] = await transaction.insert(schema.workspaces).values({ name: "Invite only", slug: `invite-${crypto.randomUUID()}` }).returning();
      const inviteToken = `invite-${crypto.randomUUID()}`;
      await transaction.insert(schema.workspaceInvites).values({ workspaceId: inviteWorkspace!.id, tokenHash: createHash("sha256").update(inviteToken).digest("hex"), role: "Member", createdBy: String(passwordUser.id), expiresAt: new Date(Date.now() + 60_000) });
      const closedSignupApp = createApp(undefined, transaction, { allowSignup: false, allowWorkspaceCreation: true }, undefined, undefined, {}, {}, {}, null, { microsoft: { ...oidc.settings, allowedEmailDomains: ["company.test"] } });
      const blocked = await signIn({ ...claims, oid: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", sub: "uninvited", email: "uninvited@company.test" }, closedSignupApp);
      expect(new URL(blocked.headers.get("location")!).searchParams.get("error")).toBe("WEFT_INVITE_REQUIRED");
      const invited = await signIn({ ...claims, oid: "ffffffff-ffff-4fff-8fff-ffffffffffff", sub: "invited", email: "invited@company.test" }, closedSignupApp, inviteToken);
      expect(invited.status).toBe(302);
      const invitedMe = await json(await closedSignupApp.handle(new Request("http://localhost/api/me", { headers: { cookie: cookieFrom(invited) } })));
      expect((invitedMe.user as Record<string, unknown>).email).toBe("invited@company.test");
      expect((invitedMe.user as Record<string, unknown>).role).not.toBe("admin");
    } finally {
      oidc.server.stop(true);
    }
  });
});

test.concurrent("Microsoft tenant and email-domain gates reject mismatched claims, and password sign-in can be disabled", async () => {
  await withRollback(db, async (transaction) => {
    const oidc = await fakeOpenIdProvider(() => new Response("Not found", { status: 404 }));
    try {
      const app = createApp(undefined, transaction, undefined, undefined, undefined, {}, {}, {}, null, {
        microsoft: { ...oidc.settings, allowedEmailDomains: ["company.test"] }, passwordSignInEnabled: false,
      });
      expect(await json(await app.handle(new Request("http://localhost/api/auth/settings")))).toEqual({ microsoftSignInEnabled: true, passwordSignInEnabled: false });
      const password = await app.handle(new Request("http://localhost/api/auth/sign-in/email", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "user@company.test", password: "secret-password" }),
      }));
      expect(password.status).not.toBe(200);
      const signUp = await app.handle(new Request("http://localhost/api/auth/sign-up/email", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Blocked", email: "blocked@company.test", password: "a-secure-password" }),
      }));
      expect(signUp.status).not.toBe(200);
    } finally {
      oidc.server.stop(true);
    }
  });
});

test.concurrent("without Microsoft settings the password experience stays enabled and no Microsoft provider is registered", async () => {
  await withRollback(db, async (transaction) => {
    const app = createApp(undefined, transaction, undefined, undefined, undefined, {}, {}, {}, null, { microsoft: {}, passwordSignInEnabled: true });
    expect(await json(await app.handle(new Request("http://localhost/api/auth/settings")))).toEqual({ microsoftSignInEnabled: false, passwordSignInEnabled: true });
    const microsoft = await app.handle(new Request("http://localhost/api/auth/sign-in/social", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: "microsoft-entra-id", callbackURL: "http://localhost:5173/" }),
    }));
    expect(microsoft.status).not.toBe(200);
    const signup = await app.handle(new Request("http://localhost/api/auth/sign-up/email", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Existing flow", email: `existing-${crypto.randomUUID()}@example.test`, password: "a-secure-password" }),
    }));
    expect(signup.status).toBe(200);
  });
});
