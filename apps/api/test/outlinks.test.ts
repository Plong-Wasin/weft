import { afterAll, expect, test } from "bun:test";
import { createDatabase } from "@weft/db";
import { withRollback } from "../../../packages/db/src/test-helpers";
import { createApp } from "../src/app";

const { client, db } = createDatabase();
afterAll(async () => client.end());

test.concurrent("HTTP Backlinks hide a source in a private project from a workspace member", async () => {
  await withRollback(db, async (transaction) => {
    const app = createApp(undefined, transaction);
    const post = (name: string, body: unknown, cookie: string) => app.handle(new Request(`http://localhost/actions/${name}`, {
      method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body),
    }));
    const signUp = async (name: string) => (await app.handle(new Request("http://localhost/api/auth/sign-up/email", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, email: `${crypto.randomUUID()}@example.test`, password: "a-secure-password" }),
    }))).headers.get("set-cookie")!.split(";")[0]!;
    const owner = await signUp("Owner");
    const workspace = await (await post("create_workspace", { name: "Team", slug: `out-${crypto.randomUUID()}` }, owner)).json() as { id: string };
    const invite = await (await post("create_invite", { workspaceId: workspace.id, role: "Member" }, owner)).json() as { token: string };
    const member = await signUp("Member");
    await post("accept_invite", { token: invite.token }, member);
    const publicProject = await (await post("create_project", { workspaceId: workspace.id, name: "Public", key: "PUB", visibility: "public" }, owner)).json() as { id: string };
    const privateProject = await (await post("create_project", { workspaceId: workspace.id, name: "Private", key: "SEC", visibility: "private" }, owner)).json() as { id: string };
    const target = await (await post("create_work_item", { projectId: publicProject.id, title: "Visible" }, owner)).json() as { id: string };
    await post("create_work_item", { projectId: privateProject.id, title: "Hidden", descriptionMarkdown: `[[PUB-1|work-item:${target.id}]]` }, owner);
    const privateCollection = await (await post("create_collection", { workspaceId: workspace.id, name: "Private collection", visibility: "private" }, owner)).json() as { id: string };
    await post("create_wiki_page", { workspaceId: workspace.id, collectionId: privateCollection.id, title: "Hidden collection source", contentMarkdown: `[[Visible|work-item:${target.id}]]` }, owner);
    const response = await post("list_backlinks", { kind: "work-item", id: target.id }, member);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
  });
});
