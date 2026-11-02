import { afterAll, expect, test } from "bun:test";
import { createDatabase } from "@weft/db";
import { withRollback } from "../../../packages/db/src/test-helpers";
import { createApp } from "../src/app";

const { client, db } = createDatabase();
afterAll(async () => client.end());

test.concurrent("wiki routes over HTTP: auth, create, edit, lock conflict status", async () => {
  await withRollback(db, async (transaction) => {
    const app = createApp(undefined, transaction);
    const post = async (path: string, body: unknown, cookie?: string) => app.handle(new Request(`http://localhost${path}`, {
      method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body),
    }));
    const signUp = async () => (await post("/api/auth/sign-up/email", { name: "U", email: `${crypto.randomUUID()}@example.test`, password: "a-secure-password" })).headers.get("set-cookie")!.split(";")[0]!;
    const owner = await signUp();
    const workspace = await (await post("/actions/create_workspace", { name: "Team", slug: `t-${crypto.randomUUID()}` }, owner)).json() as { id: string };
    expect((await post("/actions/list_wiki_pages", { workspaceId: workspace.id })).status).toBe(401);
    const page = await (await post("/actions/create_wiki_page", { workspaceId: workspace.id, title: "Home" }, owner)).json() as { id: string };
    const saved = await post("/actions/update_wiki_page", { pageId: page.id, content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }] } }, owner);
    expect(saved.status).toBe(200);
    expect((await saved.json() as { contentText: string }).contentText).toBe("hi");
    const stranger = await signUp();
    expect((await post("/actions/get_wiki_page", { pageId: page.id }, stranger)).status).toBe(403);
  });
});

test.concurrent("project Pages are hidden through HTTP list, detail, activity and search routes", async () => {
  await withRollback(db, async (transaction) => {
    const app = createApp(undefined, transaction);
    const post = async (path: string, body: unknown, cookie?: string) => app.handle(new Request(`http://localhost${path}`, {
      method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body),
    }));
    const signUp = async (name: string) => (await post("/api/auth/sign-up/email", { name, email: `${crypto.randomUUID()}@example.test`, password: "a-secure-password" })).headers.get("set-cookie")!.split(";")[0]!;
    const admin = await signUp("Admin");
    const workspace = await (await post("/actions/create_workspace", { name: "Team", slug: `t-${crypto.randomUUID()}` }, admin)).json() as { id: string };
    const invite = await (await post("/actions/create_invite", { workspaceId: workspace.id, role: "Member" }, admin)).json() as { token: string };
    const author = await signUp("Author");
    await post("/actions/accept_invite", { token: invite.token }, author);
    const project = await (await post("/actions/create_project", { workspaceId: workspace.id, name: "Docs", key: `DOC${crypto.randomUUID().slice(0, 4).replaceAll("-", "A").toUpperCase()}`, visibility: "public" }, author)).json() as { id: string };
    const shared = await (await post("/actions/create_wiki_page", { workspaceId: workspace.id, projectId: project.id, title: "Release plan" }, author)).json() as { id: string };
    const privatePage = await (await post("/actions/create_wiki_page", { workspaceId: workspace.id, projectId: project.id, title: "Draft", access: "private" }, author)).json() as { id: string };
    const invite2 = await (await post("/actions/create_invite", { workspaceId: workspace.id, role: "Member" }, admin)).json() as { token: string };
    const outsider = await signUp("Outsider");
    await post("/actions/accept_invite", { token: invite2.token }, outsider);

    for (const cookie of [admin, outsider]) {
      expect((await post("/actions/list_project_wiki_pages", { projectId: project.id }, cookie)).status).toBe(404);
      expect((await post("/actions/get_wiki_page", { pageId: shared.id }, cookie)).status).toBe(404);
      expect((await post("/actions/get_wiki_page", { pageId: privatePage.id }, cookie)).status).toBe(404);
      expect((await post("/actions/list_wiki_page_activities", { pageId: shared.id }, cookie)).status).toBe(404);
      expect(await (await post("/actions/search_wiki_pages", { workspaceId: workspace.id, query: "Release plan" }, cookie)).json()).toEqual([]);
    }
  });
});
