import { afterAll, expect, test } from "bun:test";
import { createDatabase } from "@weft/db";
import { withRollback } from "../../../packages/db/src/test-helpers";
import { createApp } from "../src/app";

const { client, db } = createDatabase();
afterAll(async () => client.end());

test.concurrent("project routes over HTTP: create, hide private, alias lookup, archive", async () => {
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
    const owner = await signUp("Owner");
    const workspace = await (await post("/actions/create_workspace", { name: "Team", slug: `t-${crypto.randomUUID()}` }, owner.cookie)).json() as { id: string; slug: string };
    const invite = await (await post("/actions/create_invite", { workspaceId: workspace.id, role: "Member" }, owner.cookie)).json() as { token: string };
    const other = await signUp("Other");
    await post("/actions/accept_invite", { token: invite.token }, other.cookie);

    expect((await post("/actions/list_projects", { workspaceId: workspace.id })).status).toBe(401);
    expect((await post("/actions/create_project", { workspaceId: workspace.id, name: "Bad", key: "1bad", visibility: "public" }, other.cookie)).status).toBe(422);
    const project = await (await post("/actions/create_project", { workspaceId: workspace.id, name: "Secret", key: "SEC", visibility: "private" }, other.cookie)).json() as { id: string };
    expect((await post("/actions/create_project", { workspaceId: workspace.id, name: "Dup", key: "SEC", visibility: "public" }, owner.cookie)).status).toBe(400);
    // the workspace Admin sees it; a third party would not (404)
    expect((await post("/actions/get_project", { workspaceId: workspace.id, key: "SEC" }, owner.cookie)).status).toBe(200);
    expect((await post("/actions/rename_project_key", { projectId: project.id, key: "NEW" }, other.cookie)).status).toBe(200);
    const byOld = await (await post("/actions/get_project", { workspaceId: workspace.id, key: "SEC" }, other.cookie)).json();
    expect(byOld).toMatchObject({ key: "NEW", viaAlias: true });
    expect((await post("/actions/archive_project", { projectId: project.id }, other.cookie)).status).toBe(200);
    expect(await (await post("/actions/list_projects", { workspaceId: workspace.id }, other.cookie)).json()).toEqual([]);
  });
});
