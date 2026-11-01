import { afterAll, expect, test } from "bun:test";
import { createDatabase } from "@weft/db";
import { withRollback } from "../../../packages/db/src/test-helpers";
import { createApp } from "../src/app";

const { client, db } = createDatabase();
afterAll(async () => client.end());

test.concurrent("search route over HTTP: Thai substring, display ID via old key, auth", async () => {
  await withRollback(db, async (transaction) => {
    const app = createApp(undefined, transaction);
    const post = async (path: string, body: unknown, cookie?: string) => app.handle(new Request(`http://localhost${path}`, {
      method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body),
    }));
    const signUp = await post("/api/auth/sign-up/email", { name: "Owner", email: `${crypto.randomUUID()}@example.test`, password: "a-secure-password" });
    const cookie = signUp.headers.get("set-cookie")!.split(";")[0]!;
    const workspace = await (await post("/actions/create_workspace", { name: "Team", slug: `t-${crypto.randomUUID()}` }, cookie)).json() as { id: string };
    const project = await (await post("/actions/create_project", { workspaceId: workspace.id, name: "Mobile", key: "MOB", visibility: "public" }, cookie)).json() as { id: string };
    await post("/actions/create_work_item", { projectId: project.id, title: "แก้ไขหน้าเข้าสู่ระบบ" }, cookie);
    await post("/actions/rename_project_key", { projectId: project.id, key: "APP" }, cookie);

    expect((await post("/actions/search_work_items", { workspaceId: workspace.id, query: "x" })).status).toBe(401);
    expect((await post("/actions/search_work_items", { workspaceId: workspace.id, query: "" }, cookie)).status).toBe(422);
    const thai = await (await post("/actions/search_work_items", { workspaceId: workspace.id, query: "เข้าสู่ระบบ" }, cookie)).json() as Array<{ displayId: string }>;
    expect(thai.map((row) => row.displayId)).toEqual(["APP-1"]);
    const alias = await (await post("/actions/search_work_items", { workspaceId: workspace.id, query: "MOB-1" }, cookie)).json() as Array<{ displayId: string }>;
    expect(alias.map((row) => row.displayId)).toEqual(["APP-1"]);
  });
});
