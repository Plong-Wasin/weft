import { afterAll, expect, test } from "bun:test";
import { createDatabase, schema } from "@weft/db";
import { withRollback } from "../../../packages/db/src/test-helpers";
import { createApp } from "../src/app";

const { client, db } = createDatabase();
afterAll(async () => client.end());

async function json(response: Response) {
  return response.json() as Promise<Record<string, unknown>>;
}

test.concurrent("sign up, create the first workspace, sign in, and sign out use cookie sessions", async () => {
  await withRollback(db, async (transaction) => {
    const app = createApp(undefined, transaction);
    const email = `${crypto.randomUUID()}@example.test`;
    const signup = await app.handle(new Request("http://localhost/api/auth/sign-up/email", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Ada", email, password: "a-secure-password" }),
    }));
    expect(signup.status).toBe(200);
    const cookie = signup.headers.get("set-cookie")?.split(";")[0];
    expect(cookie).toContain("better-auth.session_token=");

    const workspaces = await app.handle(new Request("http://localhost/api/me", { headers: { cookie: cookie! } }));
    expect((await json(workspaces)).workspaces).toEqual([]);
    const created = await app.handle(new Request("http://localhost/actions/create_workspace", {
      method: "POST", headers: { "content-type": "application/json", cookie: cookie! },
      body: JSON.stringify({ name: "First team", slug: `first-${crypto.randomUUID()}` }),
    }));
    expect(created.status).toBe(200);
    const workspace = await json(created);
    expect(workspace.name).toBe("First team");
    expect((await transaction.select().from(schema.workspaceMembers)).filter((member) => member.workspaceId === workspace.id)).toHaveLength(1);
    const landed = await app.handle(new Request("http://localhost/api/me", { headers: { cookie: cookie! } }));
    expect((await json(landed)).workspaces).toEqual([expect.objectContaining({ slug: workspace.slug })]);

    const signout = await app.handle(new Request("http://localhost/api/auth/sign-out", { method: "POST", headers: { cookie: cookie! } }));
    expect(signout.status).toBe(200);
    const signedOut = await app.handle(new Request("http://localhost/api/me", { headers: { cookie: cookie! } }));
    expect(signedOut.status).toBe(401);

    const signin = await app.handle(new Request("http://localhost/api/auth/sign-in/email", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "a-secure-password" }),
    }));
    expect(signin.status).toBe(200);
    expect(signin.headers.get("set-cookie")).toContain("better-auth.session_token=");
  });
});

test.concurrent("signup is rejected once a workspace exists when open signup is disabled", async () => {
  await withRollback(db, async (transaction) => {
    const app = createApp(undefined, transaction, { allowSignup: false, allowWorkspaceCreation: true });
    await transaction.insert(schema.users).values({ id: "existing-user", name: "Existing", email: `${crypto.randomUUID()}@example.test` });
    await transaction.insert(schema.workspaces).values({ name: "Existing workspace", slug: `existing-${crypto.randomUUID()}` });
    const response = await app.handle(new Request("http://localhost/api/auth/sign-up/email", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "New", email: `${crypto.randomUUID()}@example.test`, password: "a-secure-password" }),
    }));
    expect(response.status).toBe(403);
  });
});

test.concurrent("with open signup disabled, an invitee with a valid invite token can still sign up; an expired or unknown token cannot", async () => {
  await withRollback(db, async (transaction) => {
    const app = createApp(undefined, transaction, { allowSignup: false, allowWorkspaceCreation: true });
    const [owner] = await transaction.insert(schema.users).values({ id: `owner-${crypto.randomUUID()}`, name: "Owner", email: `${crypto.randomUUID()}@example.test` }).returning();
    const [workspace] = await transaction.insert(schema.workspaces).values({ name: "Closed", slug: `closed-${crypto.randomUUID()}` }).returning();
    const hash = async (value: string) => Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))).toString("hex");
    await transaction.insert(schema.workspaceInvites).values({ workspaceId: workspace!.id, tokenHash: await hash("good-token"), role: "Member", createdBy: owner!.id, expiresAt: new Date(Date.now() + 60_000) });
    await transaction.insert(schema.workspaceInvites).values({ workspaceId: workspace!.id, tokenHash: await hash("old-token"), role: "Member", createdBy: owner!.id, expiresAt: new Date(Date.now() - 60_000) });
    const signUp = (token?: string) => app.handle(new Request("http://localhost/api/auth/sign-up/email", {
      method: "POST", headers: { "content-type": "application/json", ...(token ? { "x-weft-invite": token } : {}) },
      body: JSON.stringify({ name: "Invitee", email: `${crypto.randomUUID()}@example.test`, password: "a-secure-password" }),
    }));
    expect((await signUp()).status).toBe(403);
    expect((await signUp("old-token")).status).toBe(403);
    expect((await signUp("nope")).status).toBe(403);
    expect((await signUp("good-token")).status).toBe(200);
  });
});
