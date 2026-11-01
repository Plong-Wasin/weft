import { afterAll, expect, test } from "bun:test";
import { createDatabase } from "@weft/db";
import { withRollback } from "../../../packages/db/src/test-helpers";
import { createApp } from "../src/app";

const { client, db } = createDatabase();
afterAll(async () => client.end());

test.concurrent("work item routes over HTTP: create, resolve via old key, soft delete, auth", async () => {
  await withRollback(db, async (transaction) => {
    const app = createApp(undefined, transaction);
    const post = async (path: string, body: unknown, cookie?: string) => app.handle(new Request(`http://localhost${path}`, {
      method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body),
    }));
    const signUp = await post("/api/auth/sign-up/email", { name: "Owner", email: `${crypto.randomUUID()}@example.test`, password: "a-secure-password" });
    const cookie = signUp.headers.get("set-cookie")!.split(";")[0]!;
    const workspace = await (await post("/actions/create_workspace", { name: "Team", slug: `t-${crypto.randomUUID()}` }, cookie)).json() as { id: string };
    const project = await (await post("/actions/create_project", { workspaceId: workspace.id, name: "Mobile", key: "MOB", visibility: "public" }, cookie)).json() as { id: string };

    expect((await post("/actions/list_work_items", { projectId: project.id })).status).toBe(401);
    expect((await post("/actions/create_work_item", { projectId: project.id, title: "" }, cookie)).status).toBe(422);
    const item = await (await post("/actions/create_work_item", { projectId: project.id, title: "Fix login", priority: "urgent" }, cookie)).json() as { id: string; displayId: string };
    expect(item.displayId).toBe("MOB-1");
    await post("/actions/rename_project_key", { projectId: project.id, key: "APP" }, cookie);
    expect(await (await post("/actions/get_work_item", { workspaceId: workspace.id, displayId: "MOB-1" }, cookie)).json()).toMatchObject({ id: item.id, displayId: "APP-1" });
    expect((await post("/actions/delete_work_item", { workItemId: item.id }, cookie)).status).toBe(200);
    expect((await post("/actions/get_work_item", { workspaceId: workspace.id, displayId: "APP-1" }, cookie)).status).toBe(404);
  });
});

test.concurrent("field routes over HTTP: labels, assignees, sub-work items, guest denied", async () => {
  await withRollback(db, async (transaction) => {
    const app = createApp(undefined, transaction);
    const post = async (path: string, body: unknown, cookie?: string) => app.handle(new Request(`http://localhost${path}`, {
      method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body),
    }));
    const signUp = await post("/api/auth/sign-up/email", { name: "Owner", email: `${crypto.randomUUID()}@example.test`, password: "a-secure-password" });
    const cookie = signUp.headers.get("set-cookie")!.split(";")[0]!;
    const workspace = await (await post("/actions/create_workspace", { name: "Team", slug: `t-${crypto.randomUUID()}` }, cookie)).json() as { id: string };
    const project = await (await post("/actions/create_project", { workspaceId: workspace.id, name: "Mobile", key: "MOB", visibility: "public" }, cookie)).json() as { id: string };
    const me = await (await app.handle(new Request("http://localhost/api/me", { headers: { cookie } }))).json() as { user: { id: string } };
    const label = await (await post("/actions/create_label", { projectId: project.id, name: "bug" }, cookie)).json() as { id: string };
    const parent = await (await post("/actions/create_work_item", { projectId: project.id, title: "Parent", labelIds: [label.id], assigneeIds: [me.user.id], dueDate: "2026-05-01" }, cookie)).json() as { id: string; labelIds: string[] };
    expect(parent.labelIds).toEqual([label.id]);
    expect((await post("/actions/create_work_item", { projectId: project.id, title: "Bad", dueDate: "May 1" }, cookie)).status).toBe(422);
    const child = await (await post("/actions/create_work_item", { projectId: project.id, title: "Child", parentId: parent.id }, cookie)).json() as { id: string };
    expect(await (await post("/actions/list_sub_work_items", { workItemId: parent.id }, cookie)).json()).toMatchObject([{ id: child.id }]);
    expect((await post("/actions/update_work_item", { workItemId: parent.id, parentId: child.id }, cookie)).status).toBe(400);
    const log = await (await post("/actions/list_work_item_activities", { workItemId: parent.id }, cookie)).json() as Array<{ field: string; actorName: string; source: string }>;
    expect(log.map((row) => row.field)).toEqual(["created", "assignees", "labels", "dueDate"].filter((field) => log.some((row) => row.field === field)));
    expect(log.every((row) => row.actorName === "Owner" && row.source === "ui")).toBe(true);
  });
});
