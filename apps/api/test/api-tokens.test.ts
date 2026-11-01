import { afterAll, expect, test } from "bun:test";
import { createDatabase } from "@weft/db";
import { withRollback } from "../../../packages/db/src/test-helpers";
import { createApp } from "../src/app";

const { client, db } = createDatabase();
afterAll(async () => client.end());

test.concurrent("token auth reaches Actions as its owner with source cli; revoked and foreign tokens fail; sessions unaffected", async () => {
  await withRollback(db, async (transaction) => {
    const app = createApp(undefined, transaction);
    const call = async (path: string, body: unknown, headers: Record<string, string> = {}) => app.handle(new Request(`http://localhost${path}`, {
      method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
    }));
    const signUp = async (name: string) => {
      const response = await call("/api/auth/sign-up/email", { name, email: `${crypto.randomUUID()}@example.test`, password: "a-secure-password" });
      return { cookie: response.headers.get("set-cookie")!.split(";")[0]! };
    };
    const owner = await signUp("Owner");
    const stranger = await signUp("Stranger");
    const workspace = await (await call("/actions/create_workspace", { name: "Team", slug: `t-${crypto.randomUUID()}` }, { cookie: owner.cookie })).json() as { id: string };
    const created = await (await call("/actions/create_api_token", { name: "cli" }, { cookie: owner.cookie })).json() as { id: string; token: string };
    const bearer = { authorization: `Bearer ${created.token}` };

    const project = await (await call("/actions/create_project", { workspaceId: workspace.id, name: "Mobile", key: "MOB", visibility: "public" }, bearer)).json() as { id: string };
    expect(project.id).toBeString();
    const item = await (await call("/actions/create_work_item", { projectId: project.id, title: "From CLI" }, bearer)).json() as { id: string };
    const log = await (await call("/actions/list_work_item_activities", { workItemId: item.id }, { cookie: owner.cookie })).json() as Array<{ source: string }>;
    expect(log.length).toBeGreaterThan(0);
    expect(log.every((row) => row.source === "cli")).toBe(true);

    expect((await call("/actions/list_projects", { workspaceId: workspace.id }, { authorization: "Bearer weft_bogus" })).status).toBe(401);
    expect((await call("/actions/list_projects", { workspaceId: workspace.id }, { cookie: owner.cookie })).status).toBe(200);
    const strangerToken = await (await call("/actions/create_api_token", { name: "x" }, { cookie: stranger.cookie })).json() as { token: string };
    expect((await call("/actions/list_projects", { workspaceId: workspace.id }, { authorization: `Bearer ${strangerToken.token}` })).status).toBe(403);
    expect((await call("/actions/list_api_tokens", {}, bearer)).status).toBe(403);
    expect((await call("/actions/revoke_api_token", { tokenId: created.id }, { cookie: stranger.cookie })).status).toBe(404);
    expect((await call("/actions/list_projects", { workspaceId: workspace.id }, bearer)).status).toBe(200);

    expect((await call("/actions/revoke_api_token", { tokenId: created.id }, { cookie: owner.cookie })).status).toBe(200);
    expect((await call("/actions/list_projects", { workspaceId: workspace.id }, bearer)).status).toBe(401);
  });
});
