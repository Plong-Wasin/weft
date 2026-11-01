import { afterAll, expect, test } from "bun:test";
import { createDatabase } from "@weft/db";
import { withRollback } from "../../../packages/db/src/test-helpers";
import { createApp } from "../src/app";

const { client, db } = createDatabase();
afterAll(async () => client.end());

test.concurrent("invite flow over HTTP: admin invites, new user signs up and joins, guest cannot change roles", async () => {
  await withRollback(db, async (transaction) => {
    const app = createApp(undefined, transaction);
    const post = async (path: string, body: unknown, cookie?: string) => app.handle(new Request(`http://localhost${path}`, {
      method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body),
    }));
    const signUp = async (name: string) => {
      const response = await post("/api/auth/sign-up/email", { name, email: `${crypto.randomUUID()}@example.test`, password: "a-secure-password" });
      const body = await response.json() as { user: { id: string } };
      return { cookie: response.headers.get("set-cookie")!.split(";")[0]!, id: body.user.id };
    };
    const admin = await signUp("Admin");
    const workspace = await (await post("/actions/create_workspace", { name: "Team", slug: `t-${crypto.randomUUID()}` }, admin.cookie)).json() as { id: string; slug: string };

    expect((await post("/actions/create_invite", { workspaceId: workspace.id, role: "Guest" })).status).toBe(401);
    const invite = await (await post("/actions/create_invite", { workspaceId: workspace.id, role: "Guest" }, admin.cookie)).json() as { token: string };

    const guest = await signUp("Guest");
    const joined = await post("/actions/accept_invite", { token: invite.token }, guest.cookie);
    expect(joined.status).toBe(200);
    expect(await joined.json()).toMatchObject({ slug: workspace.slug, role: "Guest" });
    const me = await (await app.handle(new Request("http://localhost/api/me", { headers: { cookie: guest.cookie } }))).json() as { workspaces: unknown[] };
    expect(me.workspaces).toHaveLength(1);

    expect((await post("/actions/list_members", { workspaceId: workspace.id }, guest.cookie)).status).toBe(200);
    const denied = await post("/actions/change_member_role", { workspaceId: workspace.id, userId: guest.id, role: "Admin" }, guest.cookie);
    expect(denied.status).toBe(403);
    expect((await post("/actions/accept_invite", { token: "bogus" }, guest.cookie)).status).toBe(404);
    const changed = await post("/actions/change_member_role", { workspaceId: workspace.id, userId: guest.id, role: "Member" }, admin.cookie);
    expect(changed.status).toBe(200);
    expect((await post("/actions/remove_member", { workspaceId: workspace.id, userId: guest.id }, admin.cookie)).status).toBe(200);
  });
});
