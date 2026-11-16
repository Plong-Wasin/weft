import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createDatabase, schema } from "@weft/db";
import { withRollback } from "../../../packages/db/src/test-helpers";
import { createApp } from "../src/app";

const { client, db } = createDatabase();
afterAll(async () => client.end());

test("invite sign-up and password change refuse a breached password without exposing it or its hash", async () => {
  await withRollback(db, async (transaction) => {
    const ownerId = `owner-${crypto.randomUUID()}`;
    const inviteToken = crypto.randomUUID();
    await transaction.insert(schema.users).values({ id: ownerId, name: "Owner", email: `${crypto.randomUUID()}@example.test` });
    const [workspace] = await transaction.insert(schema.workspaces).values({ name: "Invited", slug: `invited-${crypto.randomUUID()}` }).returning();
    const tokenHash = createHash("sha256").update(inviteToken).digest("hex");
    await transaction.insert(schema.workspaceInvites).values({ workspaceId: workspace!.id, tokenHash, role: "Member", createdBy: ownerId, expiresAt: new Date(Date.now() + 60_000) });
    const leaked = "very-unique-breached-password";
    const leakedHash = createHash("sha1").update(leaked).digest("hex").toUpperCase();
    const app = createApp(undefined, transaction, { allowSignup: false, allowWorkspaceCreation: true }, undefined, undefined, undefined, {
      online: true,
      rangeChecker: async (prefix) => prefix === leakedHash.slice(0, 5) ? `${leakedHash.slice(5)}:42\n` : "",
    });
    const request = (password: string, email = `${crypto.randomUUID()}@example.test`) => app.handle(new Request("http://localhost/api/auth/sign-up/email", {
      method: "POST", headers: { "content-type": "application/json", "x-weft-invite": inviteToken },
      body: JSON.stringify({ name: "Ada", email, password }),
    }));
    const refused = await request(leaked);
    const refusalBody = await refused.text();
    expect(refused.status).not.toBe(200);
    expect(refusalBody).toContain("PASSWORD_COMPROMISED");
    expect(refusalBody).not.toContain(leaked);
    expect(refusalBody).not.toContain(leakedHash);

    const email = `${crypto.randomUUID()}@example.test`;
    const created = await request("safe-pass-unique-918!", email);
    expect(created.status).toBe(200);
    const cookie = created.headers.get("set-cookie")?.split(";")[0];
    expect(cookie).toBeTruthy();
    const accepted = await app.handle(new Request("http://localhost/actions/accept_invite", {
      method: "POST", headers: { "content-type": "application/json", cookie: cookie! }, body: JSON.stringify({ token: inviteToken }),
    }));
    expect(accepted.status).toBe(200);
    const changed = await app.handle(new Request("http://localhost/api/auth/change-password", {
      method: "POST", headers: { "content-type": "application/json", cookie: cookie! },
      body: JSON.stringify({ currentPassword: "safe-pass-unique-918!", newPassword: leaked }),
    }));
    const changeBody = await changed.text();
    expect(changed.status).not.toBe(200);
    expect(changeBody).not.toContain(leaked);
    expect(changeBody).not.toContain(leakedHash);
  });
});

test("an existing account can sign in with a password shorter than the current minimum", async () => {
  await withRollback(db, async (transaction) => {
    const email = `${crypto.randomUUID()}@example.test`;
    const lowMinimumApp = createApp(undefined, transaction, undefined, undefined, undefined, undefined, { online: false, minimum: 4 });
    const created = await lowMinimumApp.handle(new Request("http://localhost/api/auth/sign-up/email", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Existing", email, password: "short1" }),
    }));
    expect(created.status).toBe(200);
    const currentMinimumApp = createApp(undefined, transaction, undefined, undefined, undefined, undefined, { online: false, minimum: 10 });
    const signin = await currentMinimumApp.handle(new Request("http://localhost/api/auth/sign-in/email", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "short1" }),
    }));
    expect(signin.status).toBe(200);
  });
});

test("a failed sign-in answers the same for an unknown email as for a wrong password, whatever the password length", async () => {
  await withRollback(db, async (transaction) => {
    const email = `${crypto.randomUUID()}@example.test`;
    const app = createApp(undefined, transaction, undefined, undefined, undefined, undefined, { online: false, minimum: 10 });
    const created = await app.handle(new Request("http://localhost/api/auth/sign-up/email", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Known", email, password: "a-long-enough-password" }),
    }));
    expect(created.status).toBe(200);
    const signIn = async (address: string, password: string) => {
      const response = await app.handle(new Request("http://localhost/api/auth/sign-in/email", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: address, password }) }));
      return { status: response.status, body: await response.json() as { code?: string } };
    };
    const known = await signIn(email, "abc");
    const unknown = await signIn(`${crypto.randomUUID()}@example.test`, "abc");
    expect(unknown).toEqual(known);
    expect(known.body.code).toBe("INVALID_EMAIL_OR_PASSWORD");
  });
});
