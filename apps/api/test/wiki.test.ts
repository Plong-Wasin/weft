import { afterAll, expect, test } from "bun:test";
import { createDatabase } from "@weft/db";
import { withRollback } from "../../../packages/db/src/test-helpers";
import { createApp } from "../src/app";

const { client, db } = createDatabase();
afterAll(async () => client.end());

test.concurrent("wiki routes over HTTP: auth, create, and persist edits without an edit lock", async () => {
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

test.concurrent("Wiki page sharing over HTTP enforces each Share role and revokes access", async () => {
  await withRollback(db, async (transaction) => {
    const app = createApp(undefined, transaction);
    const post = async (name: string, body: unknown, cookie: string) => app.handle(new Request(`http://localhost/actions/${name}`, {
      method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body),
    }));
    const signUp = async (name: string) => (await app.handle(new Request("http://localhost/api/auth/sign-up/email", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, email: `${crypto.randomUUID()}@example.test`, password: "a-secure-password" }),
    }))).headers.get("set-cookie")!.split(";")[0]!;
    const owner = await signUp("Owner");
    const workspace = await (await post("create_workspace", { name: "Team", slug: `t-${crypto.randomUUID()}` }, owner)).json() as { id: string };
    const invite = await (await post("create_invite", { workspaceId: workspace.id, role: "Member" }, owner)).json() as { token: string };
    const member = await signUp("Member");
    await post("accept_invite", { token: invite.token }, member);
    const members = await (await post("list_members", { workspaceId: workspace.id }, owner)).json() as Array<{ userId: string; name: string }>;
    const memberId = members.find((row) => row.name === "Member")!.userId;
    const page = await (await post("create_wiki_page", { workspaceId: workspace.id, title: "Private", access: "private" }, owner)).json() as { id: string };

    expect((await post("get_wiki_page", { pageId: page.id }, member)).status).toBe(404);
    expect((await post("share_wiki_page", { pageId: page.id, userId: memberId, role: "view" }, owner)).status).toBe(200);
    expect((await post("get_wiki_page", { pageId: page.id }, member)).status).toBe(200);
    expect((await post("update_wiki_page", { pageId: page.id, title: "Denied" }, member)).status).toBe(403);
    expect((await post("share_wiki_page", { pageId: page.id, userId: memberId, role: "comment" }, owner)).status).toBe(200);
    expect((await post("update_wiki_page", { pageId: page.id, title: "Still denied" }, member)).status).toBe(403);
    expect((await post("share_wiki_page", { pageId: page.id, userId: memberId, role: "edit" }, owner)).status).toBe(200);
    expect((await post("update_wiki_page", { pageId: page.id, title: "Edited" }, member)).status).toBe(200);
    const shared = await post("list_shared_wiki_pages", { workspaceId: workspace.id }, member);
    expect(await shared.json()).toMatchObject([{ id: page.id, title: "Edited" }]);
    expect((await post("revoke_wiki_page_share", { pageId: page.id, userId: memberId }, owner)).status).toBe(200);
    expect((await post("get_wiki_page", { pageId: page.id }, member)).status).toBe(404);
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

test.concurrent("archive actions enforce owner and Admin permissions over HTTP and restore only the page", async () => {
  await withRollback(db, async (transaction) => {
    const app = createApp(undefined, transaction);
    const post = async (name: string, body: unknown, cookie: string) => app.handle(new Request(`http://localhost/actions/${name}`, {
      method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body),
    }));
    const signUp = async (name: string) => (await app.handle(new Request("http://localhost/api/auth/sign-up/email", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, email: `${crypto.randomUUID()}@example.test`, password: "a-secure-password" }),
    }))).headers.get("set-cookie")!.split(";")[0]!;
    const admin = await signUp("Admin");
    const workspace = await (await post("create_workspace", { name: "Team", slug: `t-${crypto.randomUUID()}` }, admin)).json() as { id: string };
    const invite = await (await post("create_invite", { workspaceId: workspace.id, role: "Member" }, admin)).json() as { token: string };
    const owner = await signUp("Owner");
    await post("accept_invite", { token: invite.token }, owner);
    const project = await (await post("create_project", { workspaceId: workspace.id, name: "Docs", key: `DOC${crypto.randomUUID().slice(0, 4).replaceAll("-", "A").toUpperCase()}`, visibility: "public" }, owner)).json() as { id: string };
    const projectInvite = await (await post("create_invite", { workspaceId: workspace.id, role: "Member" }, admin)).json() as { token: string };
    const member = await signUp("Member");
    await post("accept_invite", { token: projectInvite.token }, member);
    await post("add_project_member", { projectId: project.id, userId: (await (await post("list_members", { workspaceId: workspace.id }, admin)).json() as Array<{ id: string; name: string }>).find((row) => row.name === "Member")!.id, role: "Member" }, owner);
    const page = await (await post("create_wiki_page", { workspaceId: workspace.id, projectId: project.id, title: "Parent", content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "unchanged" }] }] } }, owner)).json() as { id: string };
    const child = await (await post("create_wiki_page", { workspaceId: workspace.id, projectId: project.id, parentId: page.id, title: "Child" }, owner)).json() as { id: string };
    expect((await post("archive_wiki_page", { pageId: page.id }, member)).status).toBe(403);
    expect((await post("archive_wiki_page", { pageId: page.id }, owner)).status).toBe(200);
    expect((await post("update_wiki_page", { pageId: page.id, title: "Changed" }, owner)).status).toBe(400);
    const normal = await (await post("list_project_wiki_pages", { projectId: project.id }, owner)).json() as Array<{ id: string }>;
    expect(normal.map((row) => row.id)).toEqual([child.id]);
    const archived = await (await post("list_project_wiki_pages", { projectId: project.id, archived: true }, owner)).json() as Array<{ id: string }>;
    expect(archived.map((row) => row.id)).toEqual([page.id]);
    expect((await post("unarchive_wiki_page", { pageId: page.id }, member)).status).toBe(403);
    expect((await post("unarchive_wiki_page", { pageId: page.id }, admin)).status).toBe(200);
    expect(await (await post("get_wiki_page", { pageId: page.id }, owner)).json()).toMatchObject({ title: "Parent", contentText: "unchanged", archived: false });
  });
});
