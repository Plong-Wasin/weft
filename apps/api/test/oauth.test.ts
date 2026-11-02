import { afterAll, expect, test } from "bun:test";
import { createDatabase, oauthAccessToken, oauthRefreshToken, workspaceMembers } from "@weft/db";
import { eq } from "drizzle-orm";
import { createUserFactory, createWorkspaceFactory, withRollback } from "../../../packages/db/src/test-helpers";
import { createApp } from "../src/app";

const { client, db } = createDatabase();
afterAll(async () => client.end());

test.concurrent("OAuth discovery and public client registration are available without a session", async () => {
  await withRollback(db, async (transaction) => {
    const app = createApp(undefined, transaction);
    const metadata = await app.handle(new Request("http://localhost/.well-known/oauth-authorization-server/api/auth"));
    expect(metadata.status).toBe(200);
    expect(await metadata.json()).toMatchObject({
      issuer: "http://localhost:3000/api/auth",
      authorization_endpoint: "http://localhost:3000/api/auth/oauth2/authorize",
      token_endpoint: "http://localhost:3000/api/auth/oauth2/token",
      registration_endpoint: "http://localhost:3000/api/auth/oauth2/register",
    });

    const registration = await app.handle(new Request("http://localhost/api/auth/oauth2/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "MCP Inspector",
        redirect_uris: ["http://127.0.0.1:6274/oauth/callback"],
        token_endpoint_auth_method: "none",
        application_type: "native",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    }));
    expect(registration.status).toBe(201);
    const clientInfo = await registration.json() as Record<string, unknown>;
    expect(clientInfo.client_id).toBeString();
    expect(clientInfo.client_secret).toBeUndefined();
    const confidential = await app.handle(new Request("http://localhost/api/auth/oauth2/register", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Not public", redirect_uris: ["https://example.test/callback"], token_endpoint_auth_method: "client_secret_post" }),
    }));
    expect(confidential.status).toBe(400);
  });
});

test.concurrent("a signed-in OAuth user consents, exchanges PKCE code, refreshes, and cannot manage API tokens", async () => {
  await withRollback(db, async (transaction) => {
    const app = createApp(undefined, transaction);
    const json = (path: string, body: unknown, cookie?: string) => app.handle(new Request(`http://localhost:3000${path}`, {
      method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body),
    }));
    const registration = await app.handle(new Request("http://localhost:3000/api/auth/oauth2/register", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "MCP Workbench", redirect_uris: ["http://127.0.0.1:6274/oauth/callback"],
        application_type: "native", token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
      }),
    }));
    const client = await registration.json() as { client_id: string };
    const verifier = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
    const challenge = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))).toString("base64url");
    const redirectUri = "http://127.0.0.1:6274/oauth/callback";
    const authorizeUrl = new URL("http://localhost:3000/api/auth/oauth2/authorize");
    authorizeUrl.search = new URLSearchParams({
      response_type: "code", client_id: client.client_id, redirect_uri: redirectUri,
      code_challenge: challenge, code_challenge_method: "S256", scope: "offline_access", state: "known-state",
    }).toString();
    const missingPkce = new URL(authorizeUrl);
    missingPkce.searchParams.delete("code_challenge");
    missingPkce.searchParams.delete("code_challenge_method");
    const missingPkceResponse = await app.handle(new Request(missingPkce));
    expect(missingPkceResponse.status).toBe(302);
    expect(new URL(missingPkceResponse.headers.get("location")!).searchParams.get("error")).toBe("invalid_request");
    const wrongRedirect = new URL(authorizeUrl);
    wrongRedirect.searchParams.set("redirect_uri", "http://127.0.0.1:6274/another-callback");
    const wrongRedirectResponse = await app.handle(new Request(wrongRedirect));
    expect(wrongRedirectResponse.status).toBe(302);
    expect(new URL(wrongRedirectResponse.headers.get("location")!).searchParams.get("error")).toBe("invalid_redirect");
    const login = await app.handle(new Request(authorizeUrl));
    expect(login.status).toBe(302);
    expect(new URL(login.headers.get("location")!).pathname).toBe("/oauth/sign-in");
    const email = `${crypto.randomUUID()}@example.test`;
    await json("/api/auth/sign-up/email", { name: "OAuth User", email, password: "a-secure-password" });
    const loginLocation = new URL(login.headers.get("location")!);
    const signIn = await json("/api/auth/sign-in/email", { email, password: "a-secure-password", oauth_query: loginLocation.search.slice(1) });
    const cookie = signIn.headers.get("set-cookie")!.split(";")[0]!;
    const signInResult = await signIn.json() as { redirect: boolean; url: string };
    expect(signInResult.redirect).toBe(true);
    const consentLocation = new URL(signInResult.url);
    expect(consentLocation.pathname).toBe("/oauth/consent");
    const workspaceResponse = await json("/actions/create_workspace", { name: "OAuth Workspace", slug: `oauth-${crypto.randomUUID()}` }, cookie);
    const workspace = await workspaceResponse.json() as { id: string };
    expect(consentLocation.pathname).toBe("/oauth/consent");
    const info = await app.handle(new Request(`http://localhost:3000/api/oauth/consent-info${consentLocation.search}`, { headers: { cookie } }));
    expect(await info.json()).toEqual({ clientName: "MCP Workbench", redirectHost: "127.0.0.1:6274" });
    const oauthQuery = consentLocation.search.slice(1);
    const approved = await json("/api/auth/oauth2/consent", { accept: true, oauth_query: oauthQuery }, cookie);
    expect(approved.status).toBe(200);
    const callback = new URL(((await approved.json()) as { url: string }).url);
    expect(callback.searchParams.get("state")).toBe("known-state");
    const code = callback.searchParams.get("code")!;
    const token = await app.handle(new Request("http://localhost:3000/api/auth/oauth2/token", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", client_id: client.client_id, code, redirect_uri: redirectUri, code_verifier: verifier }),
    }));
    expect(token.status).toBe(200);
    const issued = await token.json() as { access_token: string; refresh_token: string; expires_in: number };
    expect(issued.expires_in).toBe(3600);
    const [refreshRow] = await transaction.select({ createdAt: oauthRefreshToken.createdAt, expiresAt: oauthRefreshToken.expiresAt }).from(oauthRefreshToken);
    expect(Math.abs(refreshRow!.expiresAt!.getTime() - refreshRow!.createdAt!.getTime() - 30 * 24 * 60 * 60 * 1000)).toBeLessThan(1_000);
    expect((await app.handle(new Request("http://localhost:3000/api/me", { headers: { authorization: `Bearer ${issued.access_token}` } }))).status).toBe(200);
    const project = await app.handle(new Request("http://localhost:3000/actions/create_project", {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${issued.access_token}` },
      body: JSON.stringify({ workspaceId: workspace.id, name: "OAuth project", key: "OAUTH", visibility: "private" }),
    }));
    expect(project.status).toBe(200);
    const otherUser = await createUserFactory(transaction);
    const otherWorkspace = await createWorkspaceFactory(transaction);
    await transaction.insert(workspaceMembers).values({ workspaceId: otherWorkspace!.id, userId: otherUser!.id, role: "Admin" });
    const forbidden = await app.handle(new Request("http://localhost:3000/actions/list_projects", {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${issued.access_token}` },
      body: JSON.stringify({ workspaceId: otherWorkspace!.id }),
    }));
    expect(forbidden.status).toBe(403);
    expect((await app.handle(new Request("http://localhost:3000/actions/list_api_tokens", {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${issued.access_token}` }, body: "{}",
    }))).status).toBe(403);
    for (const [action, body] of [["create_api_token", { name: "from oauth" }], ["revoke_api_token", { tokenId: crypto.randomUUID() }]] as const) {
      expect((await app.handle(new Request(`http://localhost:3000/actions/${action}`, {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${issued.access_token}` }, body: JSON.stringify(body),
      }))).status).toBe(403);
    }
    const refreshed = await app.handle(new Request("http://localhost:3000/api/auth/oauth2/token", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: client.client_id, refresh_token: issued.refresh_token }),
    }));
    expect(refreshed.status).toBe(200);
    const rotated = await refreshed.json() as { access_token: string; refresh_token: string; expires_in: number };
    expect(rotated.expires_in).toBe(3600);
    expect(rotated.access_token).not.toBe(issued.access_token);
    expect(rotated.refresh_token).not.toBe(issued.refresh_token);
    const replayedRefresh = await app.handle(new Request("http://localhost:3000/api/auth/oauth2/token", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: client.client_id, refresh_token: issued.refresh_token }),
    }));
    expect(replayedRefresh.status).toBe(400);

    const repeat = new URL(authorizeUrl);
    repeat.searchParams.set("prompt", "consent");
    repeat.searchParams.set("state", "denied-state");
    const consentAgain = await app.handle(new Request(repeat, { headers: { cookie } }));
    const denyLocation = new URL(consentAgain.headers.get("location")!);
    const denied = await json("/api/auth/oauth2/consent", { accept: false, oauth_query: denyLocation.search.slice(1) }, cookie);
    const deniedCallback = new URL(((await denied.json()) as { url: string }).url);
    expect(deniedCallback.searchParams.get("error")).toBe("access_denied");
    expect(deniedCallback.searchParams.get("state")).toBe("denied-state");

    const rotatedHash = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rotated.access_token))).toString("base64url");
    await transaction.update(oauthAccessToken).set({ expiresAt: new Date(Date.now() - 1_000) }).where(eq(oauthAccessToken.token, rotatedHash));
    expect((await app.handle(new Request("http://localhost:3000/api/me", { headers: { authorization: `Bearer ${rotated.access_token}` } }))).status).toBe(401);
  });
});

test.concurrent("the consent screen names the host the app asked to return to, not its first registered one", async () => {
  await withRollback(db, async (transaction) => {
    const app = createApp(undefined, transaction);
    const json = (path: string, body: unknown) => app.handle(new Request(`http://localhost:3000${path}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }));
    const registration = await json("/api/auth/oauth2/register", {
      client_name: "Two Callbacks", redirect_uris: ["http://127.0.0.1:6274/cb", "http://127.0.0.1:6275/cb"],
      application_type: "native", token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
    });
    const client = await registration.json() as { client_id: string };
    const verifier = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
    const challenge = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))).toString("base64url");
    const authorizeUrl = new URL("http://localhost:3000/api/auth/oauth2/authorize");
    authorizeUrl.search = new URLSearchParams({
      response_type: "code", client_id: client.client_id, redirect_uri: "http://127.0.0.1:6275/cb",
      code_challenge: challenge, code_challenge_method: "S256", scope: "offline_access", state: "s",
    }).toString();
    const login = await app.handle(new Request(authorizeUrl));
    const email = `${crypto.randomUUID()}@example.test`;
    await json("/api/auth/sign-up/email", { name: "OAuth User", email, password: "a-secure-password" });
    const signIn = await json("/api/auth/sign-in/email", { email, password: "a-secure-password", oauth_query: new URL(login.headers.get("location")!).search.slice(1) });
    const cookie = signIn.headers.get("set-cookie")!.split(";")[0]!;
    const consentLocation = new URL(((await signIn.json()) as { url: string }).url);
    const info = await app.handle(new Request(`http://localhost:3000/api/oauth/consent-info${consentLocation.search}`, { headers: { cookie } }));
    expect(await info.json()).toEqual({ clientName: "Two Callbacks", redirectHost: "127.0.0.1:6275" });
  });
});
